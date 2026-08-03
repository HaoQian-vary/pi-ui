#!/usr/bin/env node
// pi-web — 本地 Web 界面,驱动 Pi (pi-coding-agent) 编码代理。
//
// 原理:spawn `pi --mode rpc`,把它的 JSONL 协议桥接到浏览器(SSE + HTTP API)。
// 前端由 Vite 构建到 web/dist,本服务静态托管。
// 用法:node server.mjs [--port 3838] [--pi <pi|path/to/cli.js>] [--cwd <工作目录>]
//
// 只绑定 127.0.0.1,不要暴露到公网。

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, readdir, stat, mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const WEB_DIR = join(ROOT, "web", "dist");

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const PORT = Number(arg("--port", process.env.PORT ?? 3838));
const PI_OPT = arg("--pi", process.env.PI ?? "");
let WORKDIR = arg("--cwd", process.env.PI_CWD ?? process.cwd());

// ---------- pi 可执行解析 ----------
// npm 全局安装在 Windows 上只有 .cmd shim,node spawn 无法直接执行 →
// 解析到 node + @earendil-works/pi-coding-agent/dist/cli.js(无 shell,无转义问题)。
function resolvePi() {
  if (PI_OPT) {
    if (/\.(js|mjs|cjs)$/.test(PI_OPT)) return { bin: process.execPath, args: [PI_OPT] };
    return { bin: PI_OPT, args: [] };
  }
  if (process.platform !== "win32") return { bin: "pi", args: [] };
  const candidates = [];
  const tryRoot = (cmd) => {
    try {
      const root = execFileSync(cmd, ["root", "-g"], { encoding: "utf8", windowsHide: true, shell: true }).trim();
      if (root) candidates.push(join(root, "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
    } catch { /* npm 不可用 */ }
  };
  tryRoot("npm");
  tryRoot("npm.cmd");
  candidates.push(
    join(process.env.APPDATA ?? "", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    join(process.env.LOCALAPPDATA ?? "", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  );
  // 追加探测 hermes 等 Node 发行版自带的 npm 全局目录(其 npm 不在 node 进程 PATH 中)
  const nodeDir = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "hermes", "node", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
    : "";
  if (nodeDir) candidates.push(nodeDir);
  for (const c of candidates) if (existsSync(c)) return { bin: process.execPath, args: [c] };
  return { bin: "pi", args: [] }; // 兜底:PATH 中存在真实二进制(手动安装)
}
const PI = resolvePi();

// ---------- 凭据迁移(一次性) ----------
// omp(Oh My Pi)的 API Key 存在 ~/.omp/agent/agent.db(auth_credentials 表),
// pi 存在 ~/.pi/agent/auth.json。首次启动时若目标 provider 缺失则补齐,
// 只做 api_key 迁移,不覆盖已存在的凭据。
const AUTH_FILE = () => join(homedir(), ".pi", "agent", "auth.json");

async function migrateOmpCredentials() {
  const ompDb = join(homedir(), ".omp", "agent", "agent.db");
  if (!existsSync(ompDb)) return;
  let creds = {};
  try {
    creds = JSON.parse((await readFile(AUTH_FILE(), "utf8")) || "{}");
  } catch { /* 文件缺失/损坏 → 从空开始 */ }
  let rows;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(ompDb, { readOnly: true });
    try {
      rows = db
        .prepare("SELECT provider, data FROM auth_credentials WHERE credential_type = 'api_key' ORDER BY created_at DESC")
        .all();
    } finally {
      db.close();
    }
  } catch { /* 读取失败 → 跳过迁移 */ }
  if (!rows?.length) return;
  // omp provider id → pi auth.json key（xiaomi 等其余同名 provider 原样迁移）
  const alias = { deepseek: "deepseek", "zhipu-coding-plan": "zai-coding-cn", xiaomi: "xiaomi" };
  const added = [];
  for (const r of rows) {
    const id = alias[r?.provider];
    if (!id || creds[id]) continue;
    let key = r.data;
    try { key = JSON.parse(r.data).key; } catch { /* data 非 JSON */ }
    if (typeof key === "string" && key.trim()) {
      creds[id] = { type: "api_key", key: key.trim() };
      added.push(id);
    }
  }
  if (!added.length) return;
  await mkdir(dirname(AUTH_FILE()), { recursive: true });
  await writeFile(AUTH_FILE(), JSON.stringify(creds, null, 2) + "\n", "utf8");
  console.log(`[MIGRATE] 已从 ~/.omp/agent/agent.db 迁移凭据到 ~/.pi/agent/auth.json: ${added.join(", ")}`);
}

// ---------- RPC 桥接状态 ----------
let child = null;
let shuttingDown = false;
let switchingWorkspace = false;
const pending = new Map(); // id -> { resolve, reject, timer }
const sseClients = new Set();
let streaming = false;
let state = null;
let seq = 0;

const nextId = () => `c${++seq}`;

const send = (frame) => {
  if (child && child.stdin.writable) child.stdin.write(JSON.stringify(frame) + "\n");
};

const broadcast = (frame) => {
  const payload = `data: ${JSON.stringify(frame)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      /* 连接已断开 */
    }
  }
};

// 发命令并等待 ack(ack 超时兜底;流式完成靠事件,不在此等待)
function command(type, payload = {}, { timeout = 60000 } = {}) {
  const id = nextId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: no response for ${type}`));
      }
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    send({ id, type, ...payload });
  });
}

async function refreshState() {
  try {
    const data = await command("get_state");
    // 附加前端需要、RPC 状态里没有的字段
    let levels = ["off"];
    try {
      levels = (await command("get_available_thinking_levels"))?.levels ?? ["off"];
    } catch { /* 无模型时可能失败 */ }
    state = { ...data, cwd: WORKDIR, thinkingLevels: levels };
    broadcast({ type: "state", data: state });
  } catch { /* pi 未就绪时静默 */ }
}

// ---------- pi 子进程 ----------
function startPi() {
  broadcast({ type: "child_status", status: "starting" });
  const piArgs = [...PI.args, "--mode", "rpc", "--approve"];
  child = spawn(PI.bin, piArgs, {
    cwd: WORKDIR,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
  });
  child.stderr.on("data", (d) => broadcast({ type: "child_stderr", text: d.toString() }));
  // pi RPC 协议:严格 LF 分帧(不能用 readline —— 它会按 Unicode 分隔符切行)
  const decoder = new StringDecoder("utf8");
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += decoder.write(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      handleFrame(frame);
    }
  });
  child.on("error", (err) => {
    broadcast({ type: "child_status", status: "error", error: String(err) });
    // 命令不存在（ENOENT）：pi 未安装，停止无限重试
    if (err?.code === "ENOENT") {
      console.error(`[ERROR] 未找到 pi 可执行文件: ${PI.bin} ${PI.args.join(" ")}`);
      console.error(`        安装方式:`);
      console.error(`          npm:                    npm install -g --ignore-scripts @earendil-works/pi-coding-agent`);
      console.error(`          macOS / Linux:          curl -fsSL https://pi.dev/install.sh | sh`);
    }
  });
  child.on("exit", (code, signal) => {
    broadcast({ type: "child_status", status: "exited", code, signal });
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("pi 进程退出"));
    }
    pending.clear();
    streaming = false;
    child = null;
    // 非主动切换时自动重启（ENOENT 不重试，避免刷屏）
    if (!shuttingDown && !switchingWorkspace && code !== null && code !== "ENOENT") {
      setTimeout(() => !child && startPi(), 1500);
    }
  });
  // pi 就绪即可应答（无 ready 事件），主动拉一次状态
  refreshState();
}

// 切换工作目录：杀掉 pi 子进程 → 更新 WORKDIR → 重启
function switchWorkspace(newDir) {
  return new Promise((resolve) => {
    const finish = () => {
      WORKDIR = newDir;
      switchingWorkspace = false;
      if (!child) startPi();
      resolve();
    };
    if (!child) {
      WORKDIR = newDir;
      startPi();
      return resolve();
    }
    switchingWorkspace = true;
    // 超时兜底：若 exit 事件未触发（进程僵死），3s 后强制继续
    const timer = setTimeout(finish, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      finish();
    });
    try {
      child.kill();
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

function handleFrame(frame) {
  switch (frame.type) {
    case "response": {
      const p = pending.get(frame.id);
      if (p) {
        pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.success) p.resolve(frame.data);
        else p.reject(new Error(frame.error || `command ${frame.command} failed`));
      }
      if (frame.command === "prompt" && frame.success) refreshState();
      broadcast(frame);
      return;
    }
    case "agent_start":
      streaming = true;
      broadcast(frame);
      return;
    case "agent_end":
      // pi 的 agent_end 之后可能有 retry/排队继续,真正结束看 agent_settled
      broadcast(frame);
      return;
    case "agent_settled":
      streaming = false;
      broadcast(frame);
      refreshState();
      return;
    case "extension_ui_request": {
      // 交互式弹窗:转发给浏览器;setStatus/setWidget/setTitle/set_editor_text 纯展示,忽略。
      // pi 侧自带超时自动收场(带 timeout 的请求到期自动以默认值结束),无需客户端计时。
      if (["select", "confirm", "input", "editor", "notify"].includes(frame.method)) {
        broadcast(frame);
      }
      return;
    }
    default:
      broadcast(frame);
  }
}

// ---------- Skills 管理 ----------
const SKILLS_ROOTS = () => [
  join(homedir(), ".pi", "agent", "skills"),
  join(WORKDIR, ".pi", "skills"),
];

async function listSkills() {
  const roots = SKILLS_ROOTS();
  const out = [];
  const seen = new Set();

  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(root, entry.name);
      const skillMd = join(skillDir, "SKILL.md");

      try {
        await stat(skillMd);
      } catch {
        continue; // 没有 SKILL.md，跳过
      }

      if (seen.has(entry.name)) continue; // 去重，优先级高的先加载
      seen.add(entry.name);

      // 解析 SKILL.md frontmatter
      const content = await readFile(skillMd, "utf8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let name = entry.name;
      let description = "";
      let globs = [];
      let alwaysApply = false;

      if (fmMatch) {
        const fm = fmMatch[1];
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        const globsMatch = fm.match(/^globs:\s*\[([^\]]+)\]$/m);
        const alwaysMatch = fm.match(/^alwaysApply:\s*(true|false)$/m);

        if (nameMatch) name = nameMatch[1].trim();
        if (descMatch) description = descMatch[1].trim();
        if (globsMatch) globs = globsMatch[1].split(",").map((g) => g.trim());
        if (alwaysMatch) alwaysApply = alwaysMatch[1] === "true";
      }

      out.push({
        name,
        description,
        globs,
        alwaysApply,
        filePath: skillMd,
        baseDir: skillDir,
        source: root.includes(".pi" + sep + "agent") ? "user" : "project",
      });
    }
  }

  return out;
}

async function readSkillContent(name) {
  const roots = SKILLS_ROOTS();
  for (const root of roots) {
    const skillMd = join(root, name, "SKILL.md");
    try {
      const content = await readFile(skillMd, "utf8");
      // 去掉 frontmatter
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
      return { name, content: body, filePath: skillMd };
    } catch {
      continue;
    }
  }
  return null;
}

// ---------- Packages(pi 包) ----------
// pi list 输出:
//   User packages:
//     npm:@foo/pi-tools
//       <installedPath>
//   Project packages:
//     ...
async function listPackages() {
  try {
    const out = await runCli(["list", "--approve"], 60000);
    const packages = [];
    let scope = "user";
    const lines = out.split(/\r?\n/);
    for (const line of lines) {
      const s = line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
      if (/^User packages:/i.test(s)) scope = "user";
      else if (/^Project packages:/i.test(s)) scope = "project";
      else if (/^\s{2}\S/.test(s)) {
        const source = s.trim();
        if (/^(npm:|git:|https?:|ssh:|\.\.?\/)/.test(source)) {
          packages.push({ source, scope });
        }
      }
    }
    return packages;
  } catch {
    return [];
  }
}

// 通过 CLI 执行 pi 命令（带超时，避免网络问题挂起）
function runCli(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PI.bin, [...PI.args, ...args], {
      windowsHide: true,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {}
      reject(new Error(`CLI 超时 (${timeoutMs}ms): pi ${args.join(" ")}`));
    }, timeoutMs);
    const cleanup = () => clearTimeout(timer);
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr || stdout || `exit ${code}`).trim()));
    });
  });
}

// 本地扩展模块发现：用户级 + 项目级 extensions 目录（Packages 页展示）
async function discoverExtensions() {
  const roots = [
    { dir: join(homedir(), ".pi", "agent", "extensions"), source: "user" },
    { dir: join(WORKDIR, ".pi", "extensions"), source: "project" },
  ];
  const out = [];
  for (const { dir, source } of roots) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      let name = null;
      if (e.isFile() && /\.(ts|js)$/.test(e.name)) {
        name = e.name.replace(/\.(ts|js)$/, "");
      } else if (e.isDirectory()) {
        // 子目录入口：index.ts/index.js
        try {
          await stat(join(dir, e.name, "index.ts"));
          name = e.name;
        } catch {
          try {
            await stat(join(dir, e.name, "index.js"));
            name = e.name;
          } catch { /* 跳过 */ }
        }
      }
      if (name) {
        out.push({ name, source, path: join(dir, e.name ?? name) });
      }
    }
  }
  return out;
}

// ---------- AI 流程总结（可选开关） ----------// 用当前激活模型(pi -p 非交互)生成一轮回答的流程总结。
// 独立子进程,不进入当前 RPC 会话、不污染上下文。失败时前端回退到本地聚合。
async function summarizeTurn(text) {
  const model = state?.model;
  const args = ["-p", "--no-session"];
  if (model?.provider && model?.id) args.push("--model", `${model.provider}/${model.id}`);
  const prompt =
    "用最简洁的中文总结下面这段 AI 回合的流程，包含四部分：理解的问题、关键决策、执行的主要步骤、最终结论/交付物。工具调用阶段也要体现。只输出总结正文，不要标题和多余内容。\n\n" +
    String(text).slice(0, 30000);
  const stdout = await runCli([...args, prompt], 45000);
  return stdout.replace(/\x1b\[[0-9;]*m/g, "").trim();
}

// ---------- 会话迁移(一次性) ----------
// omp 的会话文件与 pi 几乎同构(header version:3,条目带 id/parentId),差异:
// 1) 首行是 `title` 条目(无 id) → 丢弃;2) 显示名在 header.title / title_change 条目,
// pi 读取 session_info 条目 → 转成一条 session_info。仅迁移 v3 且带 cwd 的文件。
const SESSIONS_ROOT = () => join(homedir(), ".pi", "agent", "sessions");

async function migrateOmpSessions() {
  const ompRoot = join(homedir(), ".omp", "agent", "sessions");
  if (!existsSync(ompRoot)) return;
  const piRoot = SESSIONS_ROOT();
  let migrated = 0;
  const seen = new Set();
  for (const d of await readdir(ompRoot, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    for (const f of await readdir(join(ompRoot, d.name)).catch(() => [])) {
      if (!f.endsWith(".jsonl")) continue;
      const src = join(ompRoot, d.name, f);
      const content = await readFile(src, "utf8").catch(() => null);
      if (!content) continue;
      const lines = content.split("\n").filter(Boolean);
      let header = null;
      let title = null;
      for (const l of lines) {
        let e;
        try { e = JSON.parse(l); } catch { continue; }
        if (e?.type === "session") header = e;
        else if (e?.type === "title_change" && typeof e.title === "string") title = e.title;
      }
      if (!header?.id || typeof header.cwd !== "string" || header.version !== 3) continue;
      const enc = `--${header.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
      const target = join(piRoot, enc, f);
      if (seen.has(target) || existsSync(target)) continue;
      seen.add(target);
      const out = [JSON.stringify({ type: "session", version: 3, id: header.id, timestamp: header.timestamp, cwd: header.cwd })];
      const name = header.title ?? title;
      if (name) {
        out.push(JSON.stringify({ type: "session_info", id: cryptoRandom8(), parentId: null, timestamp: header.timestamp, name: String(name) }));
      }
      for (const l of lines) {
        let e;
        try { e = JSON.parse(l); } catch { continue; }
        if (e?.type === "session" || e?.type === "title" || e?.type === "title_change") continue;
        if (typeof e?.id !== "string") continue;
        out.push(l);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, out.join("\n") + "\n", "utf8");
      migrated++;
    }
  }
  if (migrated) console.log(`[MIGRATE] 已迁移 ${migrated} 个 omp 会话到 ${piRoot}`);
}

// ---------- 会话列表(~/.pi/agent/sessions) ----------

// 读取会话文件的摘要信息:header(cwd) + session_info 条目(显示名) + 消息计数
async function readSessionMeta(path) {
  const meta = { name: null, cwd: null, messageCount: 0 };
  try {
    const fh = await readFile(path, "utf8");
    for (const line of fh.split("\n")) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      if (entry.type === "session") meta.cwd = entry.cwd ?? null;
      else if (entry.type === "session_info" && typeof entry.name === "string") meta.name = entry.name;
      else if (entry.type === "message" && entry.message) meta.messageCount++;
    }
  } catch { /* 忽略 */ }
  return meta;
}

async function listSessions() {
  const root = SESSIONS_ROOT();
  const out = [];
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = join(root, d.name);
    let files;
    try {
      files = await readdir(sub);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(sub, f);
      try {
        const st = await stat(path);
        const m = f.match(/^([\dTZ.:+-]+)_([0-9a-f-]+)\.jsonl$/i);
        const meta = await readSessionMeta(path);
        out.push({
          path,
          file: f,
          id: m?.[2] ?? f,
          mtime: st.mtimeMs,
          size: st.size,
          cwd: meta.cwd,
          name: meta.name,
          messageCount: meta.messageCount,
        });
      } catch { /* 忽略 */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

async function readSessionMessages(path) {
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const msgs = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message) {
        msgs.push(entry.message);
      }
    } catch { /* 忽略解析失败 */ }
  }
  return msgs;
}

async function readSessionDetail(path) {
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const detail = { name: null, model: null, provider: null, thinkingLevel: null, cwd: null, messageCount: 0 };
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session") {
        detail.cwd = entry.cwd ?? null;
      } else if (entry.type === "message" && entry.message?.role === "assistant") {
        detail.model = detail.model ?? entry.message.model;
        detail.provider = detail.provider ?? entry.message.provider;
        detail.messageCount++;
      } else if (entry.type === "session_info" && typeof entry.name === "string") {
        detail.name = entry.name;
      } else if (entry.type === "thinking_level_change") {
        detail.thinkingLevel = entry.thinkingLevel ?? null;
      }
    } catch { /* 忽略解析失败 */ }
  }
  return detail;
}

// 重命名:当前激活会话走 RPC set_session_name(pi 内存态),历史会话追加 session_info 条目
async function renameSession(path, name) {
  if (state?.sessionFile && normalize(path) === normalize(state.sessionFile)) {
    await command("set_session_name", { name: String(name) });
    return;
  }
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").filter(Boolean);
  let lastId = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e && typeof e.id === "string") {
        lastId = e.id;
        break;
      }
    } catch { /* 忽略 */ }
  }
  const id = cryptoRandom8();
  const entry = { type: "session_info", id, parentId: lastId, timestamp: new Date().toISOString(), name: String(name) };
  await writeFile(path, content.endsWith("\n") ? content + JSON.stringify(entry) + "\n" : content + "\n" + JSON.stringify(entry) + "\n", "utf8");
}

function cryptoRandom8() {
  let s = "";
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(4));
  if (bytes) for (const b of bytes) s += b.toString(16).padStart(2, "0");
  else s = Math.random().toString(16).slice(2, 10);
  return s;
}

async function deleteSession(path) {
  if (state?.sessionFile && normalize(path) === normalize(state.sessionFile)) {
    throw new Error("当前会话正在使用中，请先新建会话再删除");
  }
  await unlink(path);
}

// ---------- Provider 凭据(~/.pi/agent/auth.json) ----------
// provider 表来自 pi 文档 providers.md(envMap);订阅型 OAuth 提供商需在终端 pi /login 完成。
const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] },
  { id: "ant-ling", name: "Ant Ling", env: ["ANT_LING_API_KEY"] },
  { id: "azure-openai-responses", name: "Azure OpenAI", env: ["AZURE_OPENAI_API_KEY"] },
  { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"] },
  { id: "deepseek", name: "DeepSeek", env: ["DEEPSEEK_API_KEY"] },
  { id: "nvidia", name: "NVIDIA NIM", env: ["NVIDIA_API_KEY"] },
  { id: "google", name: "Google Gemini", env: ["GEMINI_API_KEY"] },
  { id: "amazon-bedrock", name: "Amazon Bedrock", env: ["AWS_BEARER_TOKEN_BEDROCK"] },
  { id: "mistral", name: "Mistral", env: ["MISTRAL_API_KEY"] },
  { id: "groq", name: "Groq", env: ["GROQ_API_KEY"] },
  { id: "cerebras", name: "Cerebras", env: ["CEREBRAS_API_KEY"] },
  { id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", env: ["CLOUDFLARE_API_KEY"] },
  { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", env: ["CLOUDFLARE_API_KEY"] },
  { id: "xai", name: "xAI", env: ["XAI_API_KEY"] },
  { id: "openrouter", name: "OpenRouter", env: ["OPENROUTER_API_KEY"] },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", env: ["AI_GATEWAY_API_KEY"] },
  { id: "zai", name: "ZAI Coding Plan (Global)", env: ["ZAI_API_KEY"] },
  { id: "zai-coding-cn", name: "ZAI Coding Plan (China)", env: ["ZAI_CODING_CN_API_KEY"] },
  { id: "opencode", name: "OpenCode Zen", env: ["OPENCODE_API_KEY"] },
  { id: "opencode-go", name: "OpenCode Go", env: ["OPENCODE_API_KEY"] },
  { id: "radius", name: "Radius", env: ["RADIUS_API_KEY"] },
  { id: "huggingface", name: "Hugging Face", env: ["HF_TOKEN"] },
  { id: "fireworks", name: "Fireworks", env: ["FIREWORKS_API_KEY"] },
  { id: "together", name: "Together AI", env: ["TOGETHER_API_KEY"] },
  { id: "kimi-coding", name: "Kimi For Coding", env: ["KIMI_API_KEY"] },
  { id: "minimax", name: "MiniMax", env: ["MINIMAX_API_KEY"] },
  { id: "minimax-cn", name: "MiniMax (China)", env: ["MINIMAX_CN_API_KEY"] },
  { id: "qwen-token-plan", name: "Qwen Token Plan", env: ["QWEN_TOKEN_PLAN_API_KEY"] },
  { id: "qwen-token-plan-cn", name: "Qwen Token Plan (China)", env: ["QWEN_TOKEN_PLAN_CN_API_KEY"] },
  { id: "xiaomi", name: "Xiaomi MiMo", env: ["XIAOMI_API_KEY"] },
  { id: "xiaomi-token-plan-cn", name: "Xiaomi Token Plan (China)", env: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"] },
  { id: "xiaomi-token-plan-ams", name: "Xiaomi Token Plan (Amsterdam)", env: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"] },
  { id: "xiaomi-token-plan-sgp", name: "Xiaomi Token Plan (Singapore)", env: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"] },
];

async function readAuth() {
  try {
    return JSON.parse((await readFile(AUTH_FILE(), "utf8")) || "{}");
  } catch {
    return {};
  }
}

async function writeAuth(creds) {
  await mkdir(dirname(AUTH_FILE()), { recursive: true });
  await writeFile(AUTH_FILE(), JSON.stringify(creds, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

// 返回 provider 列表及凭据来源:auth(auth.json 内) | env(环境变量) | null(未配置)
async function loginProviders() {
  const creds = await readAuth();
  return PROVIDERS.map((p) => {
    const inAuth = !!creds[p.id];
    const envSet = p.env.some((v) => (process.env[v] ?? "").trim() !== "");
    return { id: p.id, name: p.name, configured: inAuth || envSet, source: inAuth ? "auth" : envSet ? "env" : null };
  });
}

// 写入 API Key 后重启 pi 子进程刷新凭据缓存
async function restartForCredentialChange() {
  await switchWorkspace(WORKDIR);
  await new Promise((res) => setTimeout(res, 1500));
}

// ---------- 原生文件夹/文件选择对话框 ----------
// 编译无窗口 C# 工具(winexe + STAThread)弹系统对话框,base64 输出避免中文路径乱码。
// 为什么不用 PowerShell：-WindowStyle Hidden / CREATE_NO_WINDOW 会把隐藏状态继承给
// 对话框窗口,导致对话框不可见而进程挂起。测试模式:OMP_PICK_FOLDER_TEST 直接返回。
const PICKER_CACHE = join(tmpdir(), "pi-web-picker");
const PICKER_EXE = join(PICKER_CACHE, "picker.exe");
const PICKER_CS = join(PICKER_CACHE, "picker.cs");
const PICKER_SRC = `using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

static class Picker {
  [STAThread]
  static void Main(string[] args) {
    bool filesMode = args.Length > 0 && args[0] == "--files";
    try {
      using (var f = new Form {
        ShowInTaskbar = false,
        Opacity = 0,
        TopMost = true,
        FormBorderStyle = FormBorderStyle.None,
        StartPosition = FormStartPosition.CenterScreen
      }) {
        f.Show();
        f.Activate();
        if (filesMode) {
          var d = new OpenFileDialog { Multiselect = true, Title = "选择文件", CheckFileExists = true };
          if (d.ShowDialog(f) == DialogResult.OK) {
            foreach (var p in d.FileNames) {
              Console.Write(Convert.ToBase64String(Encoding.UTF8.GetBytes(p)) + "\n");
            }
          }
        } else {
          var d = new FolderBrowserDialog {
            Description = "选择工作文件夹",
            ShowNewFolderButton = true
          };
          if (args.Length > 1 && Directory.Exists(args[1])) d.SelectedPath = args[1];
          if (d.ShowDialog(f) == DialogResult.OK) {
            Console.Write(Convert.ToBase64String(Encoding.UTF8.GetBytes(d.SelectedPath)));
          }
        }
      }
    } catch (Exception ex) {
      Console.Error.Write("ERROR: " + ex.Message);
      Environment.Exit(1);
    }
  }
}
`;

async function ensurePickerExe() {
  if (existsSync(PICKER_EXE)) return PICKER_EXE;
  await mkdir(PICKER_CACHE, { recursive: true });
  await writeFile(PICKER_CS, PICKER_SRC, "utf8");
  const candidates = [
    join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const csc = candidates.find((c) => existsSync(c));
  if (!csc) throw new Error("未找到 csc.exe（.NET Framework 编译器）");
  await new Promise((resolve, reject) => {
    const p = spawn(csc, ["/nologo", "/target:winexe", `/out:${PICKER_EXE}`, PICKER_CS], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`csc 编译失败 (exit ${c}): ${err}`))));
  });
  return PICKER_EXE;
}

function runPicker(args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const p = spawn(PICKER_EXE, args, {});
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      try { p.kill(); } catch { /* 已退出 */ }
      resolve([]);
    }, timeoutMs);
    p.on("error", (e) => { clearTimeout(timer); resolve([]); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve([]);
      const lines = out.trim().split(/\n/).map((s) => s.trim()).filter(Boolean);
      const paths = [];
      for (const s of lines) {
        try { paths.push(Buffer.from(s, "base64").toString("utf8")); } catch { /* 忽略坏行 */ }
      }
      resolve(paths);
    });
  });
}

// PowerShell 兜底(csc 不可用时的 fallback);BOM 必须有:PS 5.1 无 BOM 按 ANSI 读 .ps1,中文乱码
const PICKER_PS = join(PICKER_CACHE, "picker.ps1");
const PICKER_PS_SRC = `param([switch]$Files, [string]$Start)
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.ShowInTaskbar = $false
$f.Opacity = 0
$f.TopMost = $true
$f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$f.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$f.Show()
$f.Activate()
if ($Files) {
  $d = New-Object System.Windows.Forms.OpenFileDialog
  $d.Multiselect = $true
  $d.Title = '选择文件'
  $d.CheckFileExists = $true
  if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) {
    foreach ($p in $d.FileNames) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p)) }
  }
} else {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = '选择工作文件夹'
  $d.ShowNewFolderButton = $true
  if ($Start -and (Test-Path $Start)) { $d.SelectedPath = $Start }
  if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($d.SelectedPath))
  }
}
$f.Dispose()
`;

async function ensurePickerPs() {
  await mkdir(PICKER_CACHE, { recursive: true });
  await writeFile(PICKER_PS, "\uFEFF" + PICKER_PS_SRC, "utf8");
  return PICKER_PS;
}

function runPickerPowerShell(args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Minimized", "-File", PICKER_PS, ...args], {});
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      try { p.kill(); } catch { /* 已退出 */ }
      resolve([]);
    }, timeoutMs);
    p.on("error", () => { clearTimeout(timer); resolve([]); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve([]);
      const lines = out.trim().split(/\n/).map((s) => s.trim()).filter(Boolean);
      const paths = [];
      for (const s of lines) {
        try { paths.push(Buffer.from(s, "base64").toString("utf8")); } catch { /* 忽略坏行 */ }
      }
      resolve(paths);
    });
  });
}

function pickFolder(start = "") {
  if (process.env.PI_PICK_FOLDER_TEST) return Promise.resolve(process.env.PI_PICK_FOLDER_TEST);
  return (async () => {
    try {
      try {
        await ensurePickerExe();
        const paths = await runPicker(start ? [start] : []);
        return paths[0] ?? null;
      } catch {
        await ensurePickerPs();
        const paths = await runPickerPowerShell(start ? [start] : []);
        return paths[0] ?? null;
      }
    } catch (e) {
      return { error: String(e) };
    }
  })();
}

function pickFiles() {
  return (async () => {
    try {
      try {
        await ensurePickerExe();
        return await runPicker(["--files"]);
      } catch {
        await ensurePickerPs();
        return await runPickerPowerShell(["--files"]);
      }
    } catch (e) {
      return [];
    }
  })();
}

// ---------- HTTP ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(urlPath, res) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = normalize(join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 5_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// 工作区文件列表(供 Inspector → Files)
async function listFiles(dir, depth = 0) {
  const out = [];
  if (depth > 3) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const ignore = new Set([".git", "node_modules", "dist", "__pycache__", ".cache", ".venv", "web/dist"]);
  for (const e of entries) {
    if (ignore.has(e.name)) continue;
    const p = join(dir, e.name);
    const rel = p.replace(WORKDIR + sep, "");
    if (e.isDirectory()) {
      out.push({ path: rel, isDir: true, size: 0 });
      out.push(...await listFiles(p, depth + 1));
    } else {
      try {
        const s = await stat(p);
        out.push({ path: rel, isDir: false, size: s.size });
      } catch {
        out.push({ path: rel, isDir: false, size: 0 });
      }
    }
    if (out.length > 400) break;
  }
  return out.slice(0, 400);
}

async function handleApi(pathname, req, res) {
  // ---------- GET ----------
  if (req.method === "GET" && pathname === "/api/state") {
    if (!state) await refreshState();
    return json(res, 200, { ok: true, state });
  }
  if (req.method === "GET" && pathname === "/api/available_models") {
    try {
      const data = await command("get_available_models");
      return json(res, 200, { ok: true, models: data?.models ?? [] });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message ?? String(e) });
    }
  }
  if (req.method === "GET" && pathname === "/api/thinking_levels") {
    try {
      const data = await command("get_available_thinking_levels");
      return json(res, 200, { ok: true, levels: data?.levels ?? ["off"] });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message ?? String(e) });
    }
  }
  if (req.method === "GET" && pathname === "/api/commands") {
    try {
      const data = await command("get_commands");
      return json(res, 200, { ok: true, commands: data?.commands ?? [] });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message ?? String(e) });
    }
  }
  if (req.method === "GET" && pathname === "/api/sessions") {
    try {
      const sessions = await listSessions();
      return json(res, 200, { ok: true, sessions });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message ?? String(e) });
    }
  }
  if (req.method === "GET" && pathname === "/api/skills") {
    try {
      const skills = await listSkills();
      return json(res, 200, { ok: true, skills });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message ?? String(e) });
    }
  }
  if (req.method === "GET" && pathname === "/api/extensions") {
    try {
      const extensions = await discoverExtensions();
      return json(res, 200, { ok: true, extensions });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message ?? String(e) });
    }
  }
  if (req.method === "GET" && pathname === "/api/packages") {
    try {
      const packages = await listPackages();
      return json(res, 200, { ok: true, packages });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message ?? String(e) });
    }
  }
  if (req.method === "GET" && pathname === "/api/login_providers") {
    try {
      const providers = await loginProviders();
      return json(res, 200, { ok: true, providers });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message ?? String(e) });
    }
  }
  if (req.method === "GET" && pathname === "/api/files") {
    try {
      const files = await listFiles(WORKDIR);
      return json(res, 200, { ok: true, files, cwd: WORKDIR });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message ?? String(e) });
    }
  }
  if (pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    sseClients.add(res);
    broadcast({ type: "child_status", status: child ? "running" : "starting" });
    if (state) broadcast({ type: "state", data: state });
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (!["GET", "POST", "DELETE"].includes(req.method) || !pathname.startsWith("/api/")) {
    if (pathname.startsWith("/api/")) return json(res, 405, { ok: false, error: "method not allowed" });
    return serveStatic(pathname, res);
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { ok: false, error: e.message });
  }

  const fail = (e) => json(res, 500, { ok: false, error: e.message ?? String(e) });
  const simple = (type, payload = {}) => async () => {
    try {
      const data = await command(type, payload);
      if (["set_model", "set_thinking_level", "set_auto_compaction", "set_auto_retry", "set_steering_mode", "set_follow_up_mode"].includes(type)) refreshState();
      return json(res, 200, { ok: true, data });
    } catch (e) {
      return fail(e);
    }
  };

  switch (pathname) {
    case "/api/prompt": {
      if (!body?.message) return json(res, 400, { ok: false, error: "message required" });
      let message = String(body.message);
      const payload = { type: "prompt", message };
      // 前端 images 是 { dataUrl, name };pi 期望 ImageContent[]({type:"image", data, mimeType})
      if (body.images?.length) {
        payload.images = body.images.map((img) => {
          const url = typeof img === "string" ? img : img?.dataUrl;
          const m = /^data:(image\/[^;]+);base64,(.+)$/s.exec(url ?? "");
          if (m) return { type: "image", mimeType: m[1], data: m[2] };
          return img; // 已是其他格式则透传
        });
      }
      if (streaming) payload.streamingBehavior = "followUp";
      try {
        return json(res, 200, { ok: true, data: await command("prompt", payload) });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/steer": {
      if (!body?.message) return json(res, 400, { ok: false, error: "message required" });
      try {
        return json(res, 200, { ok: true, data: await command("steer", { message: String(body.message) }) });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/abort":
      send({ type: "abort" });
      return json(res, 200, { ok: true });
    case "/api/new_session": {
      try {
        await command("new_session");
        refreshState();
        return json(res, 200, { ok: true });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/set_model":
      if (!body?.provider || !body?.modelId) return json(res, 400, { ok: false, error: "provider and modelId required" });
      return simple("set_model", { provider: body.provider, modelId: body.modelId })();
    case "/api/set_thinking_level":
      if (!body?.level) return json(res, 400, { ok: false, error: "level required" });
      return simple("set_thinking_level", { level: body.level })();
    case "/api/set_auto_compaction":
      return simple("set_auto_compaction", { enabled: !!body?.enabled })();
    case "/api/set_auto_retry":
      return simple("set_auto_retry", { enabled: !!body?.enabled })();
    case "/api/set_steering_mode":
      return simple("set_steering_mode", { mode: body?.mode ?? "one-at-a-time" })();
    case "/api/set_follow_up_mode":
      return simple("set_follow_up_mode", { mode: body?.mode ?? "one-at-a-time" })();
    case "/api/switch_session": {
      if (!body?.path) return json(res, 400, { ok: false, error: "path required" });
      try {
        await command("switch_session", { sessionPath: String(body.path) });
        refreshState();
        return json(res, 200, { ok: true });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/skill_content": {
      if (!body?.name) return json(res, 400, { ok: false, error: "name required" });
      try {
        const skill = await readSkillContent(String(body.name));
        if (!skill) return json(res, 404, { ok: false, error: "skill not found" });
        return json(res, 200, { ok: true, skill });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/package_install": {
      if (!body?.source) return json(res, 400, { ok: false, error: "source required" });
      try {
        const args = ["install", String(body.source), "--approve"];
        if (body.local) args.push("-l");
        await runCli(args);
        return json(res, 200, { ok: true });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/package_remove": {
      if (!body?.source) return json(res, 400, { ok: false, error: "source required" });
      try {
        const args = ["remove", String(body.source), "--approve"];
        if (body.local) args.push("-l");
        await runCli(args);
        return json(res, 200, { ok: true });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/package_update": {
      try {
        const args = ["update"];
        if (body?.source) args.push(String(body.source));
        else args.push("--extensions");
        await runCli(args);
        return json(res, 200, { ok: true });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/login": {
      if (!body?.providerId || !body?.apiKey) return json(res, 400, { ok: false, error: "providerId and apiKey required" });
      const p = PROVIDERS.find((x) => x.id === body.providerId);
      if (!p) return json(res, 400, { ok: false, error: `unknown provider: ${body.providerId}` });
      const key = String(body.apiKey).trim();
      if (!key || key.length > 512) return json(res, 400, { ok: false, error: "invalid api key" });
      try {
        const creds = await readAuth();
        creds[p.id] = { type: "api_key", key };
        await writeAuth(creds);
        await restartForCredentialChange();
        return json(res, 200, { ok: true });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/logout": {
      if (!body?.providerId) return json(res, 400, { ok: false, error: "providerId required" });
      try {
        const creds = await readAuth();
        const removed = !!creds[body.providerId];
        delete creds[body.providerId];
        await writeAuth(creds);
        await restartForCredentialChange();
        return json(res, 200, { ok: true, removed });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/summarize_turn": {
      const text = body?.text ? String(body.text) : "";
      if (!text.trim()) return json(res, 400, { ok: false, error: "text required" });
      try {
        const summary = await summarizeTurn(text);
        return json(res, 200, { ok: true, summary });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message ?? String(e) });
      }
    }
    case "/api/ui_response": {
      const { id, value, confirmed, cancelled } = body ?? {};
      if (!id) return json(res, 400, { ok: false, error: "id required" });
      const frame = { type: "extension_ui_response", id };
      if (cancelled) frame.cancelled = true;
      else if (typeof confirmed === "boolean") frame.confirmed = confirmed;
      else frame.value = value;
      send(frame);
      return json(res, 200, { ok: true });
    }
    case "/api/create_session": {
      const { name, cwd } = body ?? {};
      try {
        // 1. 切换工作目录（若指定）
        if (cwd) {
          await switchWorkspace(String(cwd));
          // 等待新子进程就绪
          await new Promise((res) => setTimeout(res, 1500));
        }
        // 2. 新建会话
        await command("new_session");
        // 3. 设置会话名称（若指定）——RPC 的 new_session 不接收 name
        if (name) {
          await command("set_session_name", { name: String(name) });
        }
        refreshState();
        return json(res, 200, { ok: true, cwd: WORKDIR, name: name ?? null });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/pick_folder": {
      try {
        const dir = await pickFolder(body?.start ? String(body.start) : "");
        if (dir && typeof dir === "object" && dir.error) return json(res, 500, { ok: false, error: dir.error });
        return json(res, 200, { ok: true, dir });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/pick_files": {
      try {
        const paths = await pickFiles();
        return json(res, 200, { ok: true, paths });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message ?? String(e) });
      }
    }
    case "/api/get_messages": {
      if (!body?.path) return json(res, 400, { ok: false, error: "path required" });
      try {
        const msgs = await readSessionMessages(String(body.path));
        return json(res, 200, { ok: true, messages: msgs });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/get_session_detail": {
      if (!body?.path) return json(res, 400, { ok: false, error: "path required" });
      try {
        const detail = await readSessionDetail(String(body.path));
        return json(res, 200, { ok: true, detail });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/rename_session": {
      if (!body?.path || !body?.name) return json(res, 400, { ok: false, error: "path and name required" });
      try {
        await renameSession(String(body.path), String(body.name));
        return json(res, 200, { ok: true });
      } catch (e) {
        return fail(e);
      }
    }
    case "/api/delete_session": {
      if (!body?.path) return json(res, 400, { ok: false, error: "path required" });
      try {
        await deleteSession(String(body.path));
        return json(res, 200, { ok: true });
      } catch (e) {
        return fail(e);
      }
    }
    default:
      return json(res, 404, { ok: false, error: "unknown endpoint" });
  }
}

// ---------- 启动 ----------
// 先做 omp 凭据与会话迁移,再拉起 pi 子进程,最后监听 HTTP
await migrateOmpCredentials();
await migrateOmpSessions();
startPi();

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) return handleApi(url.pathname, req, res);
  return serveStatic(url.pathname, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`pi-web 已启动: http://127.0.0.1:${PORT}`);
  console.log(`  pi 命令     : ${PI.bin} ${PI.args.join(" ")}`);
  console.log(`  工作目录    : ${WORKDIR}`);
  if (!existsSync(join(WEB_DIR, "index.html"))) {
    console.log(`  [!] 未找到构建产物 ${join("web", "dist", "index.html")},请先运行: npm install && npm run build`);
  }
  console.log(`  按 Ctrl+C 退出`);
});

function shutdown() {
  shuttingDown = true;
  try {
    child?.kill();
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

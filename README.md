# pi-web

A local web UI for the [Pi](https://github.com/earendil-works/pi-mono) (pi-coding-agent) coding agent. Don't like the terminal? Use a browser instead.

> 本项目前身是 omp-web（驱动 Oh My Pi / omp 的 Web 界面），现已整体迁移到 pi：引擎、协议桥、凭据、会话与包管理全部切换为 pi。迁移要点见文末「从 omp 迁移」。

## Why this project exists

**pi is a minimal, powerful terminal-based AI coding agent — but it assumes you live in the command line.**

We built this web UI for everyone who finds terminals intimidating: people who are new to coding, who aren't comfortable with command-line tools, or who simply prefer a visual, mouse-driven interface. With `pi-web` you get:

- **No terminal required** — everything from chatting to managing models, sessions, and packages happens in the browser
- **Instant visibility** — see streaming output, thinking blocks, tool calls, token usage, and costs rendered visually instead of raw text scrolling by
- **One-click setup** — double-click `start.bat` on Windows and you're in; no command-line incantations
- **Everything at a glance** — model switching, thinking levels, working folders, session history, package manager, all in a familiar web layout

Think of it as giving pi a friendly face: all the power underneath, none of the terminal friction.

> pi is an MIT-licensed open-source AI coding agent ([earendil-works/pi-mono](https://github.com/earendil-works/pi-mono)) — the core engine this project depends on. This UI is an independent web frontend that drives pi through its RPC protocol.

## License

This project is fully open source under the **MIT License** — see [LICENSE](LICENSE).

## Table of Contents

- [Why this project exists](#why-this-project-exists)
- [Features](#features)
- [Architecture](#architecture)
- [Install & Usage](#install--usage)
- [UI Overview](#ui-overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Protocol Notes](#protocol-notes)
- [Development](#development)
- [Known Limitations](#known-limitations)
- [Migrating from omp](#migrating-from-omp)

---

## Features

### Core Chat

- **Streaming rendering**: tokens stream in live, collapsible thinking blocks, tool calls shown as terminal-style cards with real-time output
- **GitHub-style diff viewer**: ` ```diff ` blocks auto-highlight (+green / -red)
- **Message metadata**: model, token usage, and cost per reply
- **Interjection (steering)**: type while the AI is replying to pause output and redirect with your new instruction
- **Abort**: red "Stop" button or Esc to terminate the current reply anytime
- **Adaptive thinking level**: dropdown only shows levels the current model supports (from `get_available_thinking_levels`)
- **Image upload**: paste, drag-drop, or click to attach images with messages

### Session Management

- **New session**: optional name + working folder (folder browser with drive/directory navigation)
- **Workspace switching**: each session binds an independent workspace; the model works in the selected directory (restarts pi to take effect)
- **History**: searchable, grouped by date (Today / Yesterday / Last 7 Days / Earlier), sortable by time or name
- **Full replay**: opening a session restores all messages (user/assistant/tool calls/thinking/cost) — continue, not restart
- **Session ops**: rename (writes a `session_info` entry, or via RPC for the active session), delete (with confirmation), hover shortcuts
- **Persistent names**: custom names show in the top bar and history

### Extensibility

- **Packages**: install/uninstall/update Pi packages (`pi install npm:…` / `git:…`), user vs project scope, local extension module browser
- **Skills**: discover installed capability packs (user `~/.pi/agent/skills/`, project `.pi/skills/`), view content, copy `skill://` references, use in one click
- **Slash commands**: dynamic autocomplete from `get_commands` (extension commands, prompt templates, `skill:` skills)
- **Model manager**: model list by provider, filter, search, switch current model

### Settings & Appearance

Everything visual and behavioral is configurable from the UI — no config file editing required:

- **Language**: switch between **中文 / English** anytime in **Settings → Appearance** — defaults to Chinese, persisted across restarts
- **Model switching**: pick your model from the top bar dropdown (grouped by provider, shows context window), or manage the full list in **Models**
- **Appearance**: switch themes anytime in **Settings → Appearance** — Dark / Light / System / Midnight / GitHub Dark / GitHub Light, CSS-variable driven, instant, persisted
- **Provider auth**: manage API keys from **Settings → Login** — keys are written to `~/.pi/agent/auth.json` (0600, your home directory, never in this project) and take effect after an automatic pi restart
  - Status shows whether a provider is configured via `auth.json` or an environment variable
  - One-time migration from omp: if `~/.omp/agent/agent.db` exists, the server copies `api_key` credentials into `auth.json` on first start (never overwrites existing entries)
  - OAuth subscriptions (Anthropic/OpenAI/Google accounts) require `pi /login` in a terminal — not available over RPC
- **Agent behavior**: auto-compaction, auto-retry, steering/follow-up queue modes, thinking level — apply live

### Other

- Extension UI dialogs (confirm / input / select / editor / notify) auto-forwarded to browser modals
- Multi-tab status bar: context usage bar, token rate, session info
- Binds 127.0.0.1 only — never exposed to LAN/public

---

## Architecture

```
Browser UI (web/src)  ⇄  HTTP/SSE  ⇄  server.mjs  ⇄  pi --mode rpc  ⇄  (Model API)
```

- **server.mjs** (Node.js): spawns `pi --mode rpc --approve`, bridges its JSONL protocol into browser-friendly SSE events + HTTP API; also serves the built frontend and manages sessions/packages/credentials
- **web/src** (React): pure frontend consuming the event stream via EventSource

### Backend Responsibilities

| Responsibility | Description |
|---|---|
| RPC bridge | `pi --mode rpc` stdio ↔ SSE + HTTP |
| Static hosting | Serves Vite build output (web/dist) |
| Sessions | list (JSONL under `~/.pi/agent/sessions/`), switch, rename, delete, history replay |
| Workspace | restarts the pi child with a new cwd |
| Ecosystem | packages (`pi list/install/remove/update`), skills/extension discovery |
| Credentials | `~/.pi/agent/auth.json` read/write, omp→pi one-time migration |
| Directory browser | folder picker backend (drives/dirs/parent) |

---

## Install & Usage

### Requirements

- **Node.js ≥ 20** (Node 22+ recommended)
- **pi** (required, the engine): `pi --mode rpc` must work with model credentials configured

### Windows One-Click

Double-click `start.bat`. It checks the environment, cleans the port, installs deps (first run), builds the frontend, opens the browser, and starts the server.

If pi is missing, it shows install instructions:

```
Windows / macOS / Linux (npm):  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
macOS / Linux (installer):      curl -fsSL https://pi.dev/install.sh | sh
```

### Manual

```bash
npm install          # first run
npm run build        # build frontend to web/dist
node server.mjs      # default port 3838
```

Options:

```bash
node server.mjs --port 8080          # change port
node server.mjs --cwd D:/work        # set pi working dir (sessions live here)
node server.mjs --pi /path/to/pi     # custom pi binary (or a path to dist/cli.js)
```

### Dev Mode (HMR)

```bash
npm run dev          # Vite dev server :5173, proxies /api to 3838
node server.mjs      # run backend in another terminal
```

Open http://127.0.0.1:3838 (prod) or http://127.0.0.1:5173 (dev).

---

## UI Overview

Three-column layout (design language inspired by OpenAI Codex / Cursor):

```
┌──────────┬─────────────────────────────┬──────────┐
│ Sidebar  │  Workspace                  │ Inspector│
│  · Logo  │  · session name  workdir    │ · Context│
│  · New   │  · [Model▼] [Thinking▼] Idle│ · Files  │
│  · Nav   │  · message stream           │ · Logs   │
│  · bottom│  · composer (interject/stop)│ · Tasks  │
│  Provider│                             │ · Tools  │
│  Model   │                             │          │
└──────────┴─────────────────────────────┴──────────┘
```

- **Left Sidebar**: new session, navigation (History / Prompts / Skills / Workspaces / Packages / Models / Settings), footer shows Provider / Model / Context usage
- **Center Workspace**: top bar (session name, working dir, model switch, thinking level, agent status, context bar) + message stream + composer
- **Right Inspector**: Context / Files / Logs / Tasks / Memory / Tools / Variables panels with real session data

### Navigation Pages

| Page | Purpose |
|---|---|
| Chat | main conversation |
| History | search/group/rename/delete sessions, full replay |
| Prompts | prompt templates, one-click fill |
| Skills | discovered capability packs, view/copy/use |
| Workspaces | current working dir & session storage |
| Packages | pi package install/uninstall/update + local extensions |
| Models | model list: filter/search/switch |
| Settings | agent behavior + provider auth + appearance |

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite 5 |
| Styling | TailwindCSS 3 + CSS variable theme system |
| Rendering | marked (Markdown) + hand-rolled diff parser |
| Icons | inline SVG (zero deps) |
| Backend | Node.js ≥ 20 (native http, zero frameworks) |
| DB access | node:sqlite (omp credential migration only) |
| State | React Context + useReducer (no Redux) |
| Transport | EventSource (SSE) + fetch (HTTP) |

---

## Project Structure

```
├── server.mjs          # Node backend: RPC bridge + static hosting + session/package/credential APIs
├── start.bat           # Windows one-click launcher
├── AGENTS.md           # project rules (loaded by pi as context file)
├── .pi/settings.json   # repo-committed pi project settings (compaction policy)
├── vite.config.mjs     # Vite config
├── tailwind.config.js  # Tailwind config (colors reference CSS vars)
├── package.json
└── web/
    ├── index.html      # Vite entry
    └── src/
        ├── main.jsx    # React entry
        ├── App.jsx     # three-column layout + ThemeProvider
        ├── store.jsx   # global state (useReducer) + SSE event machine
        ├── api.js      # HTTP API wrapper
        ├── ThemeProvider.jsx  # theme state + localStorage persistence
        ├── md.jsx      # Markdown + Diff rendering
        ├── icons.jsx   # inline SVG icon set
        ├── format.js   # formatting helpers
        ├── index.css   # theme variables + component styles
        ├── components/ # Sidebar/Topbar/MessageList/Composer/Inspector/...
        └── views/      # pages (Sessions/Packages/Models/Settings/...)
```

---

## Protocol Notes

Full protocol: `docs/rpc.md` inside the installed pi package (`node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`). Core facts used by this UI:

- `pi --mode rpc` uses **strict LF-delimited JSONL** — do NOT use Node `readline` (it splits on U+2028/U+2029). server.mjs uses a `StringDecoder` + `indexOf("\n")` splitter
- No `ready` event / no `negotiate_protocol`: send `get_state` immediately after spawn
- Turn lifecycle: `agent_start` → `turn_start` → `message_start/update/end` → `turn_end` → `agent_end` → **`agent_settled`** (only `agent_settled` means fully done — retries/queued continuations may follow `agent_end`)
- `message_update`'s `assistantMessageEvent.partial` carries the full message snapshot (render whole, don't stitch deltas)
- Thinking levels come from `get_available_thinking_levels` (per-model), not from model metadata
- Session names are `session_info` entries in the session JSONL (not the header); headers carry `cwd`
- Extension UI dialogs (`select`/`confirm`/`input`/`editor`) auto-resolve agent-side when their `timeout` expires — no client timers needed
- Credentials: `~/.pi/agent/auth.json` (`{provider: {type: "api_key", key}}`), env vars take priority; there is no RPC login/logout
- Packages are managed via CLI (`pi list/install/remove/update`) — no RPC commands
- `pi --approve` is passed on spawn so project `.pi/settings.json` and `.pi/skills` load in RPC mode (non-interactive modes skip the trust prompt otherwise)

---

## Development

### Adding a Page

1. Create the component in `web/src/views/`
2. Add the view id to `VIEWS` in `store.jsx`
3. Add the render branch in `Workspace.jsx`
4. For backend data: add an API in `server.mjs`, wrap it in `api.js`

### Theme System

- `index.css` defines CSS variables (`--color-*`) at top; each `[data-theme="xxx"]` overrides them
- `tailwind.config.js` colors all reference CSS vars (`bg: "var(--color-bg)"`)
- Avoid hardcoded colors in components — use CSS vars or themed classes

### Commands

```bash
npm run build    # production build
npm run dev      # dev HMR
npm start        # run backend
```

---

## Known Limitations

- Switching working dirs restarts the pi child (~seconds), interrupting any active conversation
- Package install/remove takes effect after pi restart (the CLI persists to settings; the running RPC session picks them up on next start)
- The collapsible thinking block only shows when the model emits a standalone thinking block (protocol supports it; depends on the model)
- History replay excludes nested/branch content (active-branch messages only)
- File upload supports images only (protocol only supports images)
- OAuth subscription login (Anthropic/OpenAI/Google) must be done in a terminal via `pi /login`
- pi has no MCP, no sub-agents, no plugin marketplace — by design (see pi's philosophy); the corresponding pages were removed in the migration

---

## Migrating from omp

This project was originally **omp-web** (driving Oh My Pi / omp). The migration to pi:

| omp | pi | Notes |
|---|---|---|
| `omp --mode rpc` | `pi --mode rpc --approve` | same flag family, pi has no `ready`/`negotiate_protocol` |
| `omp-overlay.yml` (`--config overlay`) | `.pi/settings.json` | repo-committed project settings; RPC 模式需 `--approve` 才会加载 |
| `~/.omp/agent/sessions` (title in header) | `~/.pi/agent/sessions` (name = `session_info` entry) | listing/rename/delete adapted |
| `~/.omp/agent/agent.db` credentials | `~/.pi/agent/auth.json` | server auto-migrates api_key credentials on first start |
| `get_login_providers` / `login` RPC | auth.json read/write + env vars | no RPC login in pi |
| marketplace / plugins / agents / MCP | packages (`pi install/list/...`) | marketplace/agents/MCP pages removed |
| fast mode / interrupt mode / pin sessions | — | removed (no pi equivalent) |
| `readline` framing | LF-only splitter | pi protocol requirement |

To keep your omp API keys after migrating, just start the server once: it copies `api_key` credentials from `~/.omp/agent/agent.db` into `~/.pi/agent/auth.json` (deepseek → deepseek, zhipu-coding-plan → zai-coding-cn) without touching existing entries.

---

# pi-web

给 [Pi](https://github.com/earendil-works/pi-mono)（pi-coding-agent）编码代理打造的本地 Web 界面。终端里用 pi 不方便？打开浏览器就能用。

## 项目初衷

**pi 是一个极其强大的终端型 AI 编码代理——但它默认使用者熟悉命令行。**

我们打造这个 Web 界面，是为了那些不习惯控制台的人：刚入门编程的新手、不熟悉命令行工具的用户，或者只是更喜欢可视化、鼠标操作界面的朋友。使用 `pi-web` 你可以：

- **无需终端**——从聊天到模型、会话、包管理，全部在浏览器里完成
- **所见即所得**——流式输出、思考过程、工具调用、token 用量、费用都以可视化卡片呈现，而不是黑压压的文字滚动
- **一键启动**——Windows 双击 `start.bat` 即用，无需任何命令行操作
- **一目了然**——模型切换、思考级别、工作目录、会话历史、包管理，全在熟悉的网页布局里

简单说：给 pi 加一张友好的脸——底层全部能力不变，免去终端摩擦。

> 本项目是独立的前端实现，通过 pi 的 RPC 协议驱动引擎。pi 是 MIT 开源编码代理（[earendil-works/pi-mono](https://github.com/earendil-works/pi-mono)）。

## 安装与使用

### 环境要求

- **Node.js ≥ 20**
- **pi**（引擎，必需）：`pi --mode rpc` 可正常启动，并已配置模型凭据

### Windows 一键启动

双击 `start.bat`：检查环境 → 清理 3838 端口 → 首次安装依赖 → 构建前端 → 打开浏览器 → 启动服务。

pi 未安装时会提示：

```
Windows / macOS / Linux (npm):  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
macOS / Linux (installer):      curl -fsSL https://pi.dev/install.sh | sh
```

### 手动启动

```bash
npm install          # 首次
npm run build        # 构建前端到 web/dist
node server.mjs      # 默认端口 3838
```

常用参数：

```bash
node server.mjs --port 8080          # 换端口
node server.mjs --cwd D:/work        # 设置 pi 工作目录（会话存放在这里）
node server.mjs --pi /path/to/pi     # 自定义 pi 二进制（或 dist/cli.js 路径）
```

## 凭据与登录

- **API Key**：Settings → 登录，选择 Provider 输入密钥即可。密钥写入 `~/.pi/agent/auth.json`（0600 权限，只在本机），保存后自动重启 pi 生效；环境变量（如 `DEEPSEEK_API_KEY`）同样可用
- **从 omp 迁移**：首次启动时，服务端自动把 `~/.omp/agent/agent.db` 里的 api_key 凭据拷贝到 `~/.pi/agent/auth.json`（deepseek → deepseek，zhipu-coding-plan → zai-coding-cn；不覆盖已有凭据）
- **订阅账号（OAuth）**：Anthropic/OpenAI/Google 等订阅登录需在终端执行 `pi /login`，RPC 模式不支持

## 特性一览

- 流式渲染、可折叠思考块、工具调用卡片、`diff` 高亮、消息 token/费用
- 插话（steer）、Esc 停止、按模型自适应的思考级别
- 图片粘贴/拖拽/点击上传
- 会话历史：按日期分组、搜索、重命名（`session_info` 条目）、删除、完整回放
- Packages：`pi install/list/remove/update` 的 Web 化界面 + 本地扩展浏览
- Skills：`~/.pi/agent/skills` 与 `.pi/skills` 自动发现、查看、`skill://` 引用、一键使用
- Slash 命令动态补全（extension 命令 / prompt 模板 / skill）
- 模型管理、主题切换（Dark/Light/System/Midnight/GitHub Dark/Light）、中英双语
- 只绑定 127.0.0.1，不暴露到局域网

## 从 omp 迁移说明

本项目前身是 **omp-web**。迁移要点：

| omp | pi |
|---|---|
| `omp --mode rpc` | `pi --mode rpc --approve` |
| `omp-overlay.yml` | `.pi/settings.json` |
| `~/.omp/agent/sessions`（标题在 header） | `~/.pi/agent/sessions`（名称 = `session_info` 条目） |
| `~/.omp/agent/agent.db` 凭据 | `~/.pi/agent/auth.json`（自动迁移） |
| `get_login_providers` / login RPC | auth.json 读写 + 环境变量 |
| marketplace / plugins / agents / MCP | Packages（`pi install/list/...`），其余页面移除 |
| fast mode / interrupt mode / 置顶会话 | 移除（pi 无对应能力） |
| `readline` 分帧 | LF-only 分帧（pi 协议要求） |

## 已知限制

- 切换工作目录会重启 pi 子进程（约数秒），打断进行中的对话
- 包安装/卸载需重启后生效（CLI 持久化到 settings，运行中的 RPC 会话下次启动加载）
- 思考块是否可折叠取决于模型是否输出独立 thinking 块
- 历史回放只含当前分支消息
- 文件上传仅支持图片（协议限制）
- pi 设计上无 MCP、子代理、插件市场——对应页面已在迁移中移除

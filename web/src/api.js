// API 封装:与 server.mjs 的 HTTP 接口对接。

async function jfetch(path, opts) {
  const r = await fetch(path, opts);
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) return { ok: false, error: j?.error ?? `HTTP ${r.status}` };
  return j ?? { ok: true };
}

export const api = {
  state: () => jfetch("/api/state"),
  models: () => jfetch("/api/available_models"),
  prompt: (message, images) =>
    jfetch("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, images }),
    }),
  steer: (message, images) =>
    jfetch("/api/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, images }),
    }),
  abort: () => jfetch("/api/abort", { method: "POST" }),
  newSession: () => jfetch("/api/new_session", { method: "POST" }),
  setModel: (provider, modelId) =>
    jfetch("/api/set_model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, modelId }),
    }),
  setThinking: (level) =>
    jfetch("/api/set_thinking_level", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level }),
    }),
  setAutoCompaction: (enabled) =>
    jfetch("/api/set_auto_compaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  setAutoRetry: (enabled) =>
    jfetch("/api/set_auto_retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  setSteeringMode: (mode) =>
    jfetch("/api/set_steering_mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  setFollowUpMode: (mode) =>
    jfetch("/api/set_follow_up_mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  uiResponse: (id, payload) =>
    jfetch("/api/ui_response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...payload }),
    }),
  sessions: () => jfetch("/api/sessions"),
  switchSession: (path) =>
    jfetch("/api/switch_session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  commands: () => jfetch("/api/commands"),
  loginProviders: () => jfetch("/api/login_providers"),
  login: (providerId, apiKey) =>
    jfetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, apiKey }),
    }),
  logout: (providerId) =>
    jfetch("/api/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId }),
    }),
  packages: () => jfetch("/api/packages"),
  packageInstall: (source, local) =>
    jfetch("/api/package_install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, local: !!local }),
    }),
  packageRemove: (source, local) =>
    jfetch("/api/package_remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, local: !!local }),
    }),
  packageUpdate: (source) =>
    jfetch("/api/package_update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: source ?? null }),
    }),
  createSession: (payload) =>
    jfetch("/api/create_session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  listDirs: (path) =>
    jfetch("/api/list_dirs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path ?? null }),
    }),
  pickFolder: (start, signal) =>
    jfetch("/api/pick_folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: start ?? null }),
      signal,
    }),
  pickFiles: () => jfetch("/api/pick_files", { method: "POST" }),
  getMessages: (path) =>
    jfetch("/api/get_messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  getSessionDetail: (path) =>
    jfetch("/api/get_session_detail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  renameSession: (path, name) =>
    jfetch("/api/rename_session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, name }),
    }),
  deleteSession: (path) =>
    jfetch("/api/delete_session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  skills: () => jfetch("/api/skills"),
  skillContent: (name) =>
    jfetch("/api/skill_content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
};

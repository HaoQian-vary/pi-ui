// 格式化工具:tokens、费用、时间、字节。

// provider 显示名:pi 的 provider id → OMP UI 名称(仅显示用,底层 id 不变,凭据/切换仍用 pi id)。
// zai-coding-cn 对应 OMP 的 zhipu-coding-plan(智谱 coding plan,迁移时凭据转存)。
const PROVIDER_LABELS = {
  "zai-coding-cn": "zhipu-coding-plan",
};

export function providerLabel(id) {
  return PROVIDER_LABELS[id] ?? id;
}

export function fmtTokens(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(c) {
  if (c == null || Number.isNaN(c) || c === 0) return "—";
  if (c < 0.0001) return "<$0.0001";
  return `$${c.toFixed(4)}`;
}

export function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

export function fmtTime(ts, lang = "zh") {
  if (!ts) return "";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  if (lang === "en") {
    if (diff < 60_000) return "just now";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} hr ago`;
  } else {
    if (diff < 60_000) return "刚刚";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  }
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtClock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function costOf(usage) {
  return usage?.cost?.total ?? null;
}

export function tokensOf(usage) {
  return usage?.totalTokens ?? null;
}

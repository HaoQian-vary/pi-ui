// 模型管理:列表、搜索、过滤、切换默认模型 + Provider 凭据(API Key)管理。
// 界面与 OMP UI 保持一致:顶部紧凑凭据配置框(徽章+输入+保存+清除)、表格 Provider 列显示已登录/未登录、
// 行内按钮为 退出/设为当前/配置 Key。pi 无 OAuth RPC 登录,所有 provider 的"登录"即写入 ~/.pi/agent/auth.json 的 API Key。
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import { api } from "../api";
import { useLang } from "../i18n";
import { PageShell } from "./PageShell";
import { fmtTokens, fmtCost, providerLabel } from "../format";
import { IconSearch, IconCheck, IconCpu, IconGlobe, IconX } from "../icons";

export function ModelsView() {
  const { t } = useLang();
  const { state, actions } = useApp();
  const { models, state: st, loginInfo } = state;
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState("全部");
  const [busy, setBusy] = useState(null);
  const keyInputRef = useRef(null);
  const [keyProvider, setKeyProvider] = useState("");
  const [keyInput, setKeyInput] = useState("");
  // 登录弹框：行内"登录"按钮打开，输入 API Key 保存（对齐 OMP UI 点击登录弹窗的交互）
  const [loginDlg, setLoginDlg] = useState(null);
  const [dlgKey, setDlgKey] = useState("");
  // 最近见过的模型（按 provider 缓存，持久化到 localStorage）：
  // 退出登录后 pi 不再返回该 provider 的模型，用缓存保留其模型行（标记未登录），重新配置后恢复。
  // 优先读取 pi 缓存，兼容 OMP UI 遗留的 omp.modelsCache。
  const modelsCacheRef = useRef(null);
  if (modelsCacheRef.current === null) {
    let raw = null;
    try { raw = localStorage.getItem("pi.modelsCache"); } catch {}
    if (!raw) { try { raw = localStorage.getItem("omp.modelsCache"); } catch {} }
    try {
      modelsCacheRef.current = new Map(raw ? JSON.parse(raw) : []);
    } catch {
      modelsCacheRef.current = new Map();
    }
  }

  useEffect(() => {
    actions.refreshLoginInfo();
  }, []);

  // 加载到模型时写入缓存（刷新页面后仍保留已退出 provider 的模型行）
  useEffect(() => {
    const cache = modelsCacheRef.current;
    let changed = false;
    for (const m of models) {
      const list = cache.get(m.provider) ?? [];
      if (!list.some((x) => x.provider === m.provider && x.id === m.id)) {
        list.push(m);
        changed = true;
      }
      cache.set(m.provider, list);
    }
    if (changed) {
      try {
        localStorage.setItem("pi.modelsCache", JSON.stringify([...cache.entries()]));
      } catch {}
    }
  }, [models]);

  // 配置 API Key：写入 ~/.pi/agent/auth.json，保存后自动重启 pi 生效（顶部框与登录弹框共用）
  const submitKey = async (providerId, apiKey) => {
    if (!providerId || !apiKey.trim()) return false;
    setBusy("save-key");
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, apiKey: apiKey.trim() }),
      }).then((res) => res.json());
      if (r?.ok) {
        actions.toast(`${t("已保存: ")}${providerId}`);
        actions.refreshLoginInfo(); // 全局刷新，Topbar 模型下拉同步恢复显示该 provider
        actions.refreshModels(); // 后台刷新，不阻塞 UI
        return true;
      }
      actions.toast(`${t("保存失败")}: ${r?.error ?? ""}`, "bad");
      return false;
    } catch (e) {
      actions.toast(String(e), "bad");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveKey = async () => {
    const ok = await submitKey(keyProvider, keyInput);
    if (ok) setKeyInput("");
  };

  // 登录弹框：确认保存后关闭
  const saveDlg = async () => {
    if (!loginDlg) return;
    const ok = await submitKey(loginDlg, dlgKey);
    if (ok) {
      setLoginDlg(null);
      setDlgKey("");
    }
  };

  // 退出登录：从 auth.json 移除该 provider 的 API Key
  const handleLogout = async (providerId) => {
    if (!window.confirm(`${t("确定退出 ")}${providerId}${t(" 的登录吗？")}\n\n${t("退出后该 Provider 的 API Key 将从本地删除，模型将不可用。需要重新登录并配置新的 API Key。")}`)) return;
    setBusy(`logout-${providerId}`);
    try {
      const r = await fetch("/api/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      }).then((res) => res.json());
      if (r?.ok) {
        actions.toast(`${t("已退出登录: ")}${providerId}`);
        actions.toast(t("已退出登录，模型保留在列表中，可重新登录后使用"));
        actions.refreshLoginInfo(); // 全局刷新，Topbar 模型下拉同步隐藏该 provider
        actions.refreshModels(); // 后台刷新，不阻塞 UI
        // 若当前模型被自动切换（原模型不可用），刷新 state 让顶部栏同步
        if (r.modelReset) {
          api.state().then((j) => j?.ok && actions.dispatch({ type: "state", state: j.state })).catch(() => {});
        }
      } else {
        actions.toast(`${t("退出失败: ")}${r?.error ?? ""}`, "bad");
      }
    } finally {
      setBusy(null);
    }
  };

  // provider -> 已登录状态 / 凭据来源(auth=auth.json 内, env=环境变量, null=未配置)
  const loginMap = useMemo(() => {
    const map = {};
    for (const p of loginInfo ?? []) map[p.id] = !!p.configured;
    return map;
  }, [loginInfo]);
  const sourceMap = useMemo(() => {
    const map = {};
    for (const p of loginInfo ?? []) map[p.id] = p.source ?? null;
    return map;
  }, [loginInfo]);
  const isConfigured = (m) => (loginMap[m.provider] ?? false);

  const providers = useMemo(() => {
    const set = new Set(models.map((m) => m.provider));
    for (const p of loginInfo ?? []) set.add(p.id);
    for (const p of modelsCacheRef.current.keys()) set.add(p);
    return ["全部", ...set];
  }, [models, loginInfo]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const rows = models.filter((m) => {
      const okP = provider === "全部" || m.provider === provider;
      const okQ = !ql || m.id.toLowerCase().includes(ql) || (m.name ?? "").toLowerCase().includes(ql) || m.provider.toLowerCase().includes(ql);
      return okP && okQ;
    });
    // 追加无模型条目的 provider 占位行（含已登录但模型尚未加载的）
    const withModel = new Set(models.map((m) => m.provider));
    const seen = new Set(rows.map((m) => `${m.provider}/${m.id}`));
    const providerPool = new Set((loginInfo ?? []).map((p) => p.id));
    for (const p of modelsCacheRef.current.keys()) providerPool.add(p);
    for (const p of providerPool) {
      if (withModel.has(p)) continue;
      const cached = modelsCacheRef.current.get(p) ?? [];
      if (!cached.length) {
        const pv = (loginInfo ?? []).find((x) => x.id === p);
        if (!pv) continue;
        const okP = provider === "全部" || p === provider;
        const okQ = !ql || p.toLowerCase().includes(ql) || (pv.name ?? "").toLowerCase().includes(ql);
        if (okP && okQ) rows.push({ kind: "provider", provider: p, id: p, name: pv.name });
        continue;
      }
      // 已退出登录的 provider：用缓存保留其模型行，标记未登录
      for (const cm of cached) {
        const key = `${cm.provider}/${cm.id}`;
        if (seen.has(key)) continue;
        const okP = provider === "全部" || cm.provider === provider;
        const okQ = !ql || cm.id.toLowerCase().includes(ql) || (cm.name ?? "").toLowerCase().includes(ql) || cm.provider.toLowerCase().includes(ql);
        if (!okP || !okQ) continue;
        seen.add(key);
        rows.push({ ...cm, kind: "cached", configured: false });
      }
    }
    return rows;
  }, [models, q, provider, loginInfo]);

  const current = `${st?.model?.provider}/${st?.model?.id}`;
  // 顶部配置框：当前选中 provider 的状态（对齐 OMP UI 的 OpenAI API Key 框）
  const keyProviderConfigured = keyProvider ? (loginMap[keyProvider] ?? false) : false;
  const keyProviderSource = keyProvider ? (sourceMap[keyProvider] ?? null) : null;

  const setDefault = async (m) => {
    setBusy(`${m.provider}/${m.id}`);
    try {
      const r = await actions.setModel(m.provider, m.id);
      if (r?.ok) actions.toast(`${t("已切换默认模型: ")}${m.id}`);
      else actions.toast(`${t("失败")}: ${r?.error ?? ""}`, "bad");
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageShell
      title={t("模型管理")}
      desc={`${t("当前 ")}${models.length}${t(" 个可用模型。未登录的 Provider 也会列出，登录后可加载其模型。")}`}
      actions={
        <button className="btn btn-ghost" onClick={() => actions.refreshModels()}>{t("刷新")}</button>
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-4">
        <div className="relative flex-1 max-w-sm">
          <IconSearch size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-secondary pointer-events-none" />
          <input className="input pl-7" placeholder={t("搜索模型…")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex gap-1 flex-wrap">
          {providers.map((p) => (
            <button key={t(p)} className={`btn h-7 text-[12px] ${provider === p ? "bg-accent border-accent text-white" : ""}`} onClick={() => setProvider(p)}>
              {t(providerLabel(p))}
            </button>
          ))}
        </div>
        {/* API Key 紧凑配置（对齐 OMP UI 的 OpenAI API Key 框，pi 支持任意 Provider 的 API Key） */}
        <div className="flex items-center gap-2 ml-auto">
          <IconGlobe size={13} className="text-accent shrink-0" />
          <select
            className="input h-7 text-[12px] w-40"
            style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" }}
            value={keyProvider}
            onChange={(e) => setKeyProvider(e.target.value)}
          >
            <option value="">{t("选择 Provider")}</option>
            {(loginInfo ?? []).map((p) => (
              <option key={p.id} value={p.id}>{providerLabel(p.id)}</option>
            ))}
          </select>
          {keyProvider && (
            <span className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${keyProviderConfigured ? "border-success/40 text-success" : "border-border text-secondary"}`}>
              {keyProviderConfigured ? t("已配置") : t("未配置")}
            </span>
          )}
          <input
            ref={keyInputRef}
            type="password"
            className="input h-7 w-40 text-[12px] font-mono"
            placeholder="sk-…"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && keyProvider && keyInput.trim() && saveKey()}
          />
          <button
            className="btn h-7 text-[12px]"
            onClick={saveKey}
            disabled={busy === "save-key" || !keyProvider || !keyInput.trim()}
          >
            {busy === "save-key" ? t("保存中…") : t("保存")}
          </button>
          {keyProvider && keyProviderSource === "auth" && (
            <button
              className="btn btn-ghost h-7 text-[12px] text-error"
              onClick={() => handleLogout(keyProvider)}
              disabled={busy === `logout-${keyProvider}`}
            >
              {busy === `logout-${keyProvider}` ? t("退出中…") : t("清除")}
            </button>
          )}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full table-fixed text-left">
          <colgroup>
            <col className="w-[27%]" />
            <col className="w-[21%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[7%]" />
            <col className="w-[8%]" />
            <col className="w-[19%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-sidebar text-[11px] text-secondary uppercase tracking-wider">
              <th className="px-3 py-2 font-medium">{t("模型")}</th>
              <th className="px-3 py-2 font-medium hidden md:table-cell">Provider</th>
              <th className="px-3 py-2 font-medium text-right hidden sm:table-cell">Context</th>
              <th className="px-3 py-2 font-medium text-right hidden lg:table-cell">Max Tokens</th>
              <th className="px-3 py-2 font-medium hidden lg:table-cell">Reasoning</th>
              <th className="px-3 py-2 font-medium text-right hidden md:table-cell">{t("成本")}</th>
              <th className="px-3 py-2 font-medium text-right">{t("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => {
              const isProviderRow = m.kind === "provider";
              const isCurrent = !isProviderRow && current === `${m.provider}/${m.id}`;
              const configured = m.configured ?? (isProviderRow ? (!!loginMap[m.provider]) : isConfigured(m));
              // 环境变量配置的凭据无法通过界面清除（对齐 OMP UI：openai 用 .env 时无"退出"）
              const canLogout = configured && (m.kind === "cached" ? false : (sourceMap[m.provider] ?? null) === "auth");
              return (
                <tr key={`${m.provider}/${m.id}`} className="border-b border-border/50 hover: transition-colors duration-100">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      {isProviderRow ? <IconGlobe size={13} className="text-secondary shrink-0" /> : <IconCpu size={13} className="text-accent shrink-0" />}
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium truncate">{m.name ?? m.id}</div>
                        <div className="text-[10.5px] text-secondary font-mono truncate">{m.id}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 hidden md:table-cell">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[12px] text-secondary font-mono truncate max-w-[160px]">{providerLabel(m.provider)}</span>
                      <span className={`text-[10.5px] px-1.5 py-0.5 rounded-full border shrink-0 ${configured ? "border-success/40 text-success" : "border-border text-secondary"}`}>
                        {configured ? t("已登录") : t("未登录")}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[12px] font-mono text-right hidden sm:table-cell">{isProviderRow ? "—" : fmtTokens(m.contextWindow)}</td>
                  <td className="px-3 py-2.5 text-[12px] font-mono text-right hidden lg:table-cell">{isProviderRow ? "—" : fmtTokens(m.maxTokens)}</td>
                  <td className="px-3 py-2.5 text-[12px] hidden lg:table-cell">{isProviderRow ? "—" : (m.reasoning ? "✓" : "—")}</td>
                  <td className="px-3 py-2.5 text-[12px] font-mono text-right hidden md:table-cell">{isProviderRow ? "—" : fmtCost(m.cost?.input)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {isCurrent && (
                        <span className={`inline-flex items-center gap-1 text-[11.5px] ${configured ? "text-success" : "text-error"}`}>
                          <IconCheck size={12} /> {configured ? t("当前") : `${t("当前")} · ${t("未登录")}`}
                        </span>
                      )}
                      {configured ? (
                        !isCurrent && (
                          <>
                            {canLogout && (
                              <button
                                className="btn btn-ghost h-6 text-[11.5px] text-error"
                                title={t("退出后该 Provider 的 API Key 将从本地删除，模型将不可用。需要重新登录并配置新的 API Key。")}
                                disabled={busy === `logout-${m.provider}`}
                                onClick={() => handleLogout(m.provider)}
                              >
                                {busy === `logout-${m.provider}` ? t("退出中…") : t("退出")}
                              </button>
                            )}
                            <button className="btn h-6 text-[11.5px]" disabled={busy === `${m.provider}/${m.id}`} onClick={() => setDefault(m)}>
                              {busy === `${m.provider}/${m.id}` ? t("切换中…") : t("设为当前")}
                            </button>
                          </>
                        )
                      ) : (
                        <button
                          className="btn h-6 text-[11.5px]"
                          onClick={() => { setLoginDlg(m.provider); setDlgKey(""); }}
                        >
                          {t("登录")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!filtered.length && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-secondary text-[13px]">{t("无匹配模型")}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 登录弹框：输入 API Key（对齐 OMP UI 点击登录弹窗的交互） */}
      {loginDlg && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 animate-fade-in"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setLoginDlg(null); }}
        >
          <div className="w-[440px] max-w-[92vw] card bg-card shadow-2xl animate-slide-up">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
              <IconGlobe size={14} className="text-accent shrink-0" />
              <span className="flex-1 text-[13.5px] font-semibold truncate">{t("登录")} · {providerLabel(loginDlg)}</span>
              <button className="btn btn-icon" onClick={() => setLoginDlg(null)}><IconX size={13} /></button>
            </div>
            <div className="px-4 py-4">
              <div className="text-[12.5px] text-secondary leading-relaxed mb-2">
                {t("输入 API Key，写入 ~/.pi/agent/auth.json，保存后自动重启 pi 生效。")}
              </div>
              <input
                autoFocus
                type="password"
                className="input h-8 font-mono"
                placeholder="sk-…"
                value={dlgKey}
                onChange={(e) => setDlgKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveDlg(); if (e.key === "Escape") setLoginDlg(null); }}
              />
              <div className="flex justify-end gap-2 mt-4">
                <button className="btn btn-ghost h-7 text-[12px]" onClick={() => setLoginDlg(null)}>{t("取消")}</button>
                <button
                  className="btn h-7 text-[12px]"
                  disabled={busy === "save-key" || !dlgKey.trim()}
                  onClick={saveDlg}
                >
                  {busy === "save-key" ? t("保存中…") : t("保存")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}

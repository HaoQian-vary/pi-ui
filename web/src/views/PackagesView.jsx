// Packages：pi 包管理（pi install/remove/update）+ 本地扩展模块展示。
import { useEffect, useState } from "react";
import { useApp } from "../store";
import { useLang } from "../i18n";
import { PageShell } from "./PageShell";
import {
  IconRefresh, IconPlug, IconDownload, IconTrash, IconFileText, IconX, IconCheck
} from "../icons";

export function PackagesView() {
  const { t } = useLang();
  const { actions } = useApp();
  const [packages, setPackages] = useState(null);
  const [extensions, setExtensions] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [installSource, setInstallSource] = useState("");
  const [installLocal, setInstallLocal] = useState(false);

  const load = async () => {
    setErr(null);
    try {
      const [pkgs, exts] = await Promise.all([
        actions.loadPackages().catch(() => []),
        fetch("/api/extensions").then((r) => r.json()).then((j) => (j.ok ? j.extensions ?? [] : [])).catch(() => []),
      ]);
      setPackages(pkgs);
      setExtensions(exts);
    } catch (e) {
      setErr(String(e));
    }
  };
  useEffect(() => { load(); }, []);

  const run = async (key, fn, okMsg) => {
    setBusy(key);
    try {
      const ok = await fn();
      if (ok) {
        if (okMsg) actions.toast(okMsg);
        load();
      } else {
        actions.toast(`${t("失败")}: ${t("请查看 pi 输出")}`, "bad");
      }
    } catch (e) {
      actions.toast(String(e), "bad");
    } finally {
      setBusy(null);
    }
  };

  const doInstall = () => {
    const src = installSource.trim();
    if (!src) return;
    run(`install-${src}`, () => actions.installPackage(src, installLocal), `${t("已安装: ")}${src}`)
      .then(() => {
        setInstallOpen(false);
        setInstallSource("");
        setInstallLocal(false);
      });
  };

  return (
    <PageShell
      title="Packages"
      desc={t("Pi 扩展包管理：安装 npm/git 包，查看本地扩展模块。")}
      actions={
        <div className="flex gap-2">
          <button className="btn" onClick={() => setInstallOpen(!installOpen)}>
            <IconDownload size={13} /> {t("安装包")}
          </button>
          <button className="btn btn-ghost" onClick={load} title={t("刷新")}>
            <IconRefresh size={13} /> {t("刷新")}
          </button>
        </div>
      }
    >
      {/* 安装输入 */}
      {installOpen && (
        <div className="card p-3 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <IconDownload size={13} className="text-accent" />
            <span className="text-[12.5px] font-medium">{t("安装 Pi 包")}</span>
            <button className="btn btn-icon ml-auto h-6 w-6" onClick={() => setInstallOpen(false)}>
              <IconX size={12} />
            </button>
          </div>
          <div className="flex gap-2">
            <input
              className="input h-8 flex-1 font-mono text-[12px]"
              placeholder="npm:@foo/pi-tools  |  git:github.com/user/repo  |  https://…"
              value={installSource}
              onChange={(e) => setInstallSource(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && installSource.trim() && doInstall()}
              autoFocus
            />
            <label className="flex items-center gap-1.5 text-[11.5px] text-secondary shrink-0">
              <input type="checkbox" checked={installLocal} onChange={(e) => setInstallLocal(e.target.checked)} />
              {t("项目级(-l)")}
            </label>
            <button
              className="btn h-8 text-[12px]"
              onClick={doInstall}
              disabled={busy === `install-${installSource.trim()}` || !installSource.trim()}
            >
              {busy?.startsWith("install-") ? t("安装中…") : t("安装")}
            </button>
          </div>
          <p className="text-[11px] text-secondary mt-1.5 leading-relaxed">
            {t("包内可包含 extensions / skills / prompts / themes。安装位置：用户级 ~/.pi/agent/npm|git，项目级 .pi/npm|git。")}
          </p>
        </div>
      )}

      {err && <div className="text-[13px] text-error mb-3">{err}</div>}

      {/* 已安装包 */}
      <h2 className="text-[13.5px] font-semibold mt-2 mb-2">{t("已安装包")}</h2>
      <div className="card divide-y divide-border/60">
        {!packages && <div className="p-4 text-[12.5px] text-secondary">{t("加载中…")}</div>}
        {packages && !packages.length && (
          <div className="p-6 text-center text-[12.5px] text-secondary">
            <IconPlug size={24} className="mx-auto opacity-40 mb-2" />
            {t("暂无已安装包。点击右上角“安装包”添加 npm/git 包。")}
          </div>
        )}
        {packages?.map((p) => (
          <div key={`${p.scope}-${p.source}`} className="px-4 py-2.5 flex items-center gap-3">
            <IconPlug size={13} className="text-accent shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-mono truncate">{p.source}</div>
              <div className="text-[10.5px] text-secondary">
                {p.scope === "user" ? t("用户级") : t("项目级")}
              </div>
            </div>
            <button
              className="btn btn-ghost h-6 text-[11px]"
              disabled={busy === `update-${p.source}`}
              onClick={() => run(`update-${p.source}`, () => actions.updatePackage(p.source), `${t("已更新: ")}${p.source}`)}
            >
              <IconRefresh size={11} /> {t("更新")}
            </button>
            <button
              className="btn btn-ghost h-6 text-[11px] text-error"
              disabled={busy === `remove-${p.source}`}
              onClick={() => {
                if (!window.confirm(`${t("确定卸载")} ${p.source} 吗？`)) return;
                run(`remove-${p.source}`, () => actions.removePackage(p.source, p.scope === "project"), `${t("已卸载: ")}${p.source}`);
              }}
            >
              <IconTrash size={11} /> {t("卸载")}
            </button>
          </div>
        ))}
      </div>

      {/* 本地扩展 */}
      <h2 className="text-[13.5px] font-semibold mt-6 mb-2">{t("本地扩展模块")}</h2>
      <div className="card divide-y divide-border/60">
        {!extensions && <div className="p-4 text-[12.5px] text-secondary">{t("加载中…")}</div>}
        {extensions && !extensions.length && (
          <div className="p-4 text-[12.5px] text-secondary">{t("暂无本地扩展。放到 ~/.pi/agent/extensions 或项目 .pi/extensions 目录即可加载。")}</div>
        )}
        {extensions?.map((e) => (
          <div key={`${e.source}-${e.name}`} className="px-4 py-2.5 flex items-center gap-3">
            <IconFileText size={13} className="text-accent shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-medium truncate">{e.name}</div>
              <div className="text-[10.5px] text-secondary font-mono truncate">{e.path}</div>
            </div>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${e.source === "user" ? "bg-accent/15 text-accent" : "bg-success/15 text-success"}`}>
              {e.source === "user" ? t("用户") : t("项目")}
            </span>
            <IconCheck size={12} className="text-success shrink-0" />
          </div>
        ))}
      </div>

      {/* 说明 */}
      <div className="card p-4 mt-4">
        <h3 className="text-[12.5px] font-medium mb-2">{t("关于 Pi 包")}</h3>
        <ul className="text-[12px] text-secondary space-y-1.5 list-disc pl-4">
          <li>{t("包通过 CLI 安装:")} <span className="font-mono text-accent">pi install npm:xxx</span> {t("或")} <span className="font-mono text-accent">pi install git:github.com/user/repo</span></li>
          <li>{t("包的安全性与插件相同：扩展会以本机权限执行任意代码，安装前请审查来源。")}</li>
          <li>{t("pi 不内置插件市场；可在 npm 搜索")} <span className="font-mono">keywords:pi-package</span></li>
        </ul>
      </div>
    </PageShell>
  );
}

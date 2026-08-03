// 中间 Workspace:Topbar + 消息列表 + Composer。非对话视图时显示对应页面。
import { useApp } from "../store";
import { Topbar } from "./Topbar";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { SessionsView } from "../views/SessionsView";
import { PromptsView } from "../views/PromptsView";
import { WorkspacesView } from "../views/WorkspacesView";
import { PackagesView } from "../views/PackagesView";
import { ModelsView } from "../views/ModelsView";
import { SettingsView } from "../views/SettingsView";
import { AppearanceView } from "../views/AppearanceView";
import { SkillsView } from "../views/SkillsView";

export function Workspace() {
  const { state } = useApp();
  const { view } = state;

  return (
    <div className="flex-1 flex flex-col min-w-0" style={{ background: "var(--color-bg)" }}>
      <Topbar />
      <div className="flex-1 flex flex-col min-h-0" style={{ overflow: "hidden" }}>
        {/* 始终挂载 Chat 视图，切到其他页时用 display:none 隐藏，保持 Composer 输入状态不丢失 */}
        <div style={{ display: view === "chat" ? undefined : "none" }} className="flex-1 flex flex-col min-h-0">
          <MessageList />
          <Composer />
        </div>
        {view === "sessions" && <SessionsView />}
        {view === "prompts" && <PromptsView />}
        {view === "skills" && <SkillsView />}
        {view === "workspaces" && <WorkspacesView />}
        {view === "packages" && <PackagesView />}
        {view === "models" && <ModelsView />}
        {view === "settings" && <SettingsView />}
        {view === "appearance" && <AppearanceView />}
      </div>
    </div>
  );
}

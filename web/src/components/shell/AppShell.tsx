// ABOUTME: The app frame — full-height sidebar on the left, main area on the right. The main area shows
// one of: the New Task page (composing), the active task page (a tab selected in the sidebar), or the
// board/list with its header. No top tab bar — open tasks live in the sidebar.
import { useState } from "react";
import { useApp } from "@/state/app-store";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { Topbar, type BoardTab } from "./Topbar";
import { BoardView } from "@/components/board/BoardView";
import { ListView } from "@/components/board/ListView";
import { NewTaskPage } from "@/components/task/NewTaskPage";
import { DeepDivePanel } from "@/components/task/DeepDivePanel";
import { useTaskDetail } from "@/components/task/useTaskDetail";
import { ManageTeamDialog } from "@/components/team/ManageTeamDialog";
import { ConnectAgentDialog } from "@/components/agent/ConnectAgentDialog";

export function AppShell() {
  const { view, selectedTaskId, selectTask, closeTab } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<BoardTab>("board");
  const [composing, setComposing] = useState(false);
  const [manageTeamOpen, setManageTeamOpen] = useState(false);
  const [connectAgentOpen, setConnectAgentOpen] = useState(false);

  // One detail controller feeds the active task page (the tab selected in the sidebar).
  const ctrl = useTaskDetail(selectedTaskId);
  const activeTeam = view.kind === "team" ? { id: view.teamId, name: view.name } : null;

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        onConnectAgent={() => setConnectAgentOpen(true)}
        onNewTask={() => setComposing(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TabBar onNavigate={() => setComposing(false)} />
        {composing ? (
          <NewTaskPage
            onCancel={() => setComposing(false)}
            onCreated={(task) => {
              setComposing(false);
              selectTask(task.id);
            }}
          />
        ) : selectedTaskId ? (
          <DeepDivePanel
            inline
            taskId={selectedTaskId}
            open
            onClose={() => closeTab(selectedTaskId)}
            ctrl={ctrl}
          />
        ) : (
          <>
            <Topbar
              tab={tab}
              onTab={setTab}
              onNewTask={() => setComposing(true)}
              onManageTeam={() => setManageTeamOpen(true)}
            />
            <div className="min-h-0 flex-1">
              {tab === "board" ? (
                <BoardView onNewTask={() => setComposing(true)} onConnectAgent={() => setConnectAgentOpen(true)} />
              ) : (
                <ListView />
              )}
            </div>
          </>
        )}
      </main>

      <ManageTeamDialog open={manageTeamOpen} onOpenChange={setManageTeamOpen} team={activeTeam} />
      <ConnectAgentDialog open={connectAgentOpen} onOpenChange={setConnectAgentOpen} />
    </div>
  );
}

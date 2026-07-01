// ABOUTME: The app frame — collapsible sidebar + main column (topbar over the board/list), plus the
// New Task, Manage team, Connect an agent dialogs and the slide-over detail panel. Views switch via
// state, never the URL.
import { useState } from "react";
import { useApp } from "@/state/app-store";
import { Sidebar } from "./Sidebar";
import { Topbar, type BoardTab } from "./Topbar";
import { BoardView } from "@/components/board/BoardView";
import { ListView } from "@/components/board/ListView";
import { NewTaskDialog } from "@/components/task/NewTaskDialog";
import { DetailPanel } from "@/components/task/DetailPanel";
import { ManageTeamDialog } from "@/components/team/ManageTeamDialog";
import { ConnectAgentDialog } from "@/components/agent/ConnectAgentDialog";

export function AppShell() {
  const { view, selectedTaskId, selectTask } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<BoardTab>("board");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [manageTeamOpen, setManageTeamOpen] = useState(false);
  const [connectAgentOpen, setConnectAgentOpen] = useState(false);

  const activeTeam = view.kind === "team" ? { id: view.teamId, name: view.name } : null;

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        onConnectAgent={() => setConnectAgentOpen(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <Topbar
          tab={tab}
          onTab={setTab}
          onNewTask={() => setNewTaskOpen(true)}
          onManageTeam={() => setManageTeamOpen(true)}
        />
        <div className="min-h-0 flex-1">
          {tab === "board" ? (
            <BoardView
              onNewTask={() => setNewTaskOpen(true)}
              onConnectAgent={() => setConnectAgentOpen(true)}
            />
          ) : (
            <ListView />
          )}
        </div>
      </main>

      <NewTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} />
      <ManageTeamDialog
        open={manageTeamOpen}
        onOpenChange={setManageTeamOpen}
        team={activeTeam}
      />
      <ConnectAgentDialog open={connectAgentOpen} onOpenChange={setConnectAgentOpen} />
      <DetailPanel taskId={selectedTaskId} onClose={() => selectTask(null)} />
    </div>
  );
}

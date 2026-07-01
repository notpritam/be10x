// ABOUTME: The app frame — a global tab bar over [sidebar + main]. The active tab is either the board
// (no task selected) or a task page (the selected task, rendered inline). Also hosts the New Task,
// Manage team, and Connect an agent dialogs.
import { useState } from "react";
import { useApp } from "@/state/app-store";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { Topbar, type BoardTab } from "./Topbar";
import { BoardView } from "@/components/board/BoardView";
import { ListView } from "@/components/board/ListView";
import { NewTaskDialog } from "@/components/task/NewTaskDialog";
import { DeepDivePanel } from "@/components/task/DeepDivePanel";
import { useTaskDetail } from "@/components/task/useTaskDetail";
import { ManageTeamDialog } from "@/components/team/ManageTeamDialog";
import { ConnectAgentDialog } from "@/components/agent/ConnectAgentDialog";

export function AppShell() {
  const { view, selectedTaskId, closeTab } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<BoardTab>("board");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [manageTeamOpen, setManageTeamOpen] = useState(false);
  const [connectAgentOpen, setConnectAgentOpen] = useState(false);

  // One detail controller feeds the active task page (the tab currently open).
  const ctrl = useTaskDetail(selectedTaskId);
  const activeTeam = view.kind === "team" ? { id: view.teamId, name: view.name } : null;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Notion layout: full-height sidebar on the left, tab bar sitting atop the main content. */}
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        onConnectAgent={() => setConnectAgentOpen(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TabBar onNewTask={() => setNewTaskOpen(true)} />
        <main className="flex min-h-0 flex-1 flex-col">
          {selectedTaskId ? (
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
            </>
          )}
        </main>
      </div>

      <NewTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} />
      <ManageTeamDialog open={manageTeamOpen} onOpenChange={setManageTeamOpen} team={activeTeam} />
      <ConnectAgentDialog open={connectAgentOpen} onOpenChange={setConnectAgentOpen} />
    </div>
  );
}

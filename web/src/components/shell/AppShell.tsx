// ABOUTME: The app frame — full-height sidebar on the left, main area on the right. The main area shows
// one of: the Profile page, the New Task page (composing), the active task page (a tab), or the
// board/list. The tab bar carries the view context + open tabs + board controls.
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useApp } from "@/state/app-store";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { type BoardTab } from "./Topbar";
import { BoardView } from "@/components/board/BoardView";
import { FleetView } from "@/components/fleet/FleetView";
import { ListView } from "@/components/board/ListView";
import { NewTaskPage } from "@/components/task/NewTaskPage";
import { ProfilePage } from "@/components/user/ProfilePage";
import { LeaderboardPage } from "@/components/leaderboard/LeaderboardPage";
import { BugsPage } from "@/components/bugs/BugsPage";
import { DeepDivePanel } from "@/components/task/DeepDivePanel";
import { useTaskDetail } from "@/components/task/useTaskDetail";
import { ManageTeamDialog } from "@/components/team/ManageTeamDialog";
import { ConnectAgentDialog } from "@/components/agent/ConnectAgentDialog";

// The active full-page panel (Bugs/Profile/Leaderboard) is a full page, not a board view, so it isn't in
// the app-store's URL. Persist it in sessionStorage so a refresh restores the same page instead of dropping
// back to the board. (The app-store rewrites the path/?v= for tasks and would clobber a URL param here.)
type Panel = "" | "bugs" | "profile" | "leaderboard";
const PANEL_KEY = "be10x.panel";
function initialPanel(): Panel {
  try {
    const p = sessionStorage.getItem(PANEL_KEY);
    return p === "bugs" || p === "profile" || p === "leaderboard" ? p : "";
  } catch {
    return "";
  }
}

export function AppShell() {
  const { view, selectedTaskId, selectTask, closeTab } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<BoardTab>("board");
  const [composing, setComposing] = useState(false);
  const [showProfile, setShowProfile] = useState(() => initialPanel() === "profile");
  const [showLeaderboard, setShowLeaderboard] = useState(() => initialPanel() === "leaderboard");
  const [showBugs, setShowBugs] = useState(() => initialPanel() === "bugs");
  const [manageTeamOpen, setManageTeamOpen] = useState(false);
  const [connectAgentOpen, setConnectAgentOpen] = useState(false);

  // One detail controller feeds the active task page (the tab selected in the tab bar).
  const ctrl = useTaskDetail(selectedTaskId);
  const activeTeam = view.kind === "team" ? { id: view.teamId, name: view.name } : null;

  // Switch the active full-page panel and remember it across refreshes.
  const setPanel = (panel: Panel) => {
    setShowProfile(panel === "profile");
    setShowLeaderboard(panel === "leaderboard");
    setShowBugs(panel === "bugs");
    try {
      sessionStorage.setItem(PANEL_KEY, panel);
    } catch {
      /* private mode / storage blocked — panel just won't persist */
    }
  };

  const startCompose = () => {
    setPanel("");
    setComposing(true);
  };
  const leaveOverlays = () => {
    setComposing(false);
    setPanel("");
  };

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        onConnectAgent={() => setConnectAgentOpen(true)}
        onNewTask={startCompose}
        onProfile={() => {
          setComposing(false);
          setPanel("profile");
        }}
        onLeaderboard={() => {
          setComposing(false);
          setPanel("leaderboard");
        }}
        onBugs={() => {
          setComposing(false);
          setPanel("bugs");
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TabBar
          onNavigate={leaveOverlays}
          tab={tab}
          onTab={setTab}
          onNewTask={startCompose}
          onManageTeam={() => setManageTeamOpen(true)}
          composing={composing}
          onCloseCompose={() => setComposing(false)}
        />
        {showProfile || showLeaderboard || showBugs ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center border-b border-border/60 px-4 py-2">
              <button
                type="button"
                onClick={() => setPanel("")}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <ArrowLeft className="size-4" /> Back
              </button>
            </div>
            {showBugs ? <BugsPage /> : showProfile ? <ProfilePage /> : <LeaderboardPage />}
          </div>
        ) : composing ? (
          <NewTaskPage
            onCancel={() => setComposing(false)}
            onCreated={(task) => {
              setComposing(false);
              selectTask(task.id);
            }}
          />
        ) : selectedTaskId ? (
          <DeepDivePanel inline taskId={selectedTaskId} open onClose={() => closeTab(selectedTaskId)} ctrl={ctrl} />
        ) : (
          <div className="min-h-0 flex-1">
            {tab === "board" ? (
              <BoardView onNewTask={startCompose} onConnectAgent={() => setConnectAgentOpen(true)} />
            ) : tab === "fleet" ? (
              <FleetView />
            ) : (
              <ListView />
            )}
          </div>
        )}
      </main>

      <ManageTeamDialog open={manageTeamOpen} onOpenChange={setManageTeamOpen} team={activeTeam} />
      <ConnectAgentDialog open={connectAgentOpen} onOpenChange={setConnectAgentOpen} />
    </div>
  );
}

// ABOUTME: The single source of truth. Holds the session, teams and every task the user can see,
// derives the sidebar views/counts client-side, and owns the governed transition (optimistic + revert).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { api, ApiError, errorMessage, type CreateTaskInput, type TaskFilter } from "@/lib/api";
import { canTransition, STATUS_META } from "@/lib/lifecycle";
import type { Status, Task, Team, User } from "@/lib/types";

export type View =
  | { kind: "all" }
  | { kind: "personal" }
  | { kind: "needs_input" }
  | { kind: "review_queue" }
  | { kind: "team"; teamId: string; name: string };

export function viewKey(view: View): string {
  return view.kind === "team" ? `team:${view.teamId}` : view.kind;
}

/** A task awaiting the given user's review — mirrors GET /api/reviews/pending. */
export function awaitsReview(task: Task, userId: string): boolean {
  return task.status === "plan_review" && task.reviewerId === userId;
}

function viewFilter(view: View, userId: string): (task: Task) => boolean {
  switch (view.kind) {
    case "all":
      return () => true;
    case "personal":
      return (t) => t.scope === "personal";
    case "needs_input":
      return (t) => t.status === "needs_input";
    case "review_queue":
      return (t) => awaitsReview(t, userId);
    case "team":
      return (t) => t.teamId === view.teamId;
  }
}

interface AppState {
  user: User;
  teams: Team[];
  allTasks: Task[];
  view: View;
  visibleTasks: Task[];
  counts: {
    all: number;
    personal: number;
    needsInput: number;
    reviewQueue: number;
    team: Record<string, number>;
  };
  tasksLoading: boolean;
  selectedTaskId: string | null;
  /** Whether the selected task is shown in the full-screen deep-dive (vs. the slide-over). */
  expanded: boolean;

  setView: (view: View) => void;
  reloadTasks: () => Promise<void>;
  reloadTeams: () => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<Task>;
  createTeam: (name: string) => Promise<Team>;
  moveTask: (taskId: string, to: Status) => Promise<boolean>;
  applyTask: (task: Task) => void;
  selectTask: (id: string | null) => void;
  /** Promote the open task from the slide-over to the full-screen deep-dive. */
  expandTask: () => void;
  /** Collapse the deep-dive back to the slide-over (keeps the task open). */
  collapseTask: () => void;
  logout: () => Promise<void>;
  resolveActor: (actorId: string) => string;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

export function AppProvider({
  user,
  onSignedOut,
  children,
}: {
  user: User;
  onSignedOut: () => void;
  children: ReactNode;
}) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [view, setView] = useState<View>({ kind: "all" });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = allTasks;

  const reloadTeams = useCallback(async () => {
    try {
      const { teams } = await api.listTeams();
      setTeams(teams);
    } catch {
      /* non-fatal */
    }
  }, []);

  const reloadTasks = useCallback(async () => {
    try {
      const { tasks } = await api.listTasks({} as TaskFilter);
      setAllTasks(tasks);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadTeams();
    void reloadTasks();
  }, [reloadTeams, reloadTasks]);

  // Board-wide live updates: poll all tasks so cards move between columns on their own as the agent
  // works — no manual refresh. (reloadTasks only clears the loading flag, so re-polling never flashes.)
  useEffect(() => {
    const t = setInterval(() => void reloadTasks(), 4000);
    return () => clearInterval(t);
  }, [reloadTasks]);

  const applyTask = useCallback((task: Task) => {
    setAllTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === task.id);
      if (idx === -1) return [task, ...prev];
      const next = prev.slice();
      next[idx] = task;
      return next;
    });
  }, []);

  const createTask = useCallback(
    async (input: CreateTaskInput) => {
      const { task } = await api.createTask(input);
      setAllTasks((prev) => [task, ...prev]);
      return task;
    },
    [],
  );

  const createTeam = useCallback(
    async (name: string) => {
      const { team } = await api.createTeam(name);
      setTeams((prev) => [...prev, team]);
      return team;
    },
    [],
  );

  const moveTask = useCallback(
    async (taskId: string, to: Status): Promise<boolean> => {
      const task = tasksRef.current.find((t) => t.id === taskId);
      if (!task) return false;
      const from = task.status;
      if (from === to) return false;

      // Client-side governance: never call the API for an illegal move.
      if (!canTransition(from, to)) {
        toast.error(`Can't move ${STATUS_META[from].label} to ${STATUS_META[to].label}`);
        return false;
      }

      // Optimistic update.
      setAllTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: to, updatedAt: Date.now() } : t)),
      );

      try {
        const { task: updated } = await api.transition(taskId, to);
        applyTask(updated);
        return true;
      } catch (err) {
        // Snap back on 409 / network failure.
        setAllTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: from } : t)));
        if (err instanceof ApiError && err.code === "ILLEGAL_TRANSITION") {
          toast.error(`Can't move ${STATUS_META[from].label} to ${STATUS_META[to].label}`);
        } else {
          toast.error(errorMessage(err));
        }
        return false;
      }
    },
    [applyTask],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    onSignedOut();
  }, [onSignedOut]);

  const selectTask = useCallback((id: string | null) => {
    setSelectedTaskId(id);
    // Deselecting always drops back out of the full-screen view.
    if (id === null) setExpanded(false);
  }, []);

  const expandTask = useCallback(() => setExpanded(true), []);
  const collapseTask = useCallback(() => setExpanded(false), []);

  const resolveActor = useCallback(
    (actorId: string): string => {
      if (actorId === user.id) return user.displayName || "You";
      if (actorId === "agent" || actorId === "worker") return "Agent";
      if (actorId === "system") return "System";
      return "Teammate";
    },
    [user],
  );

  const visibleTasks = useMemo(
    () => allTasks.filter(viewFilter(view, user.id)),
    [allTasks, view, user.id],
  );

  const counts = useMemo(() => {
    const team: Record<string, number> = {};
    for (const t of allTasks) if (t.teamId) team[t.teamId] = (team[t.teamId] ?? 0) + 1;
    return {
      all: allTasks.length,
      personal: allTasks.filter((t) => t.scope === "personal").length,
      needsInput: allTasks.filter((t) => t.status === "needs_input").length,
      reviewQueue: allTasks.filter((t) => awaitsReview(t, user.id)).length,
      team,
    };
  }, [allTasks, user.id]);

  const value: AppState = {
    user,
    teams,
    allTasks,
    view,
    visibleTasks,
    counts,
    tasksLoading,
    selectedTaskId,
    expanded,
    setView,
    reloadTasks,
    reloadTeams,
    createTask,
    createTeam,
    moveTask,
    applyTask,
    selectTask,
    expandTask,
    collapseTask,
    logout,
    resolveActor,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

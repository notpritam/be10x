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

// --- URL state -------------------------------------------------------------
// The selected task + full-view flag live in the URL (/t/<id> and /t/<id>/full), so a refresh restores
// the exact view and links are shareable. The server serves index.html for these paths (SPA fallback).
function parseLocation(): { id: string | null; expanded: boolean; viewKey: string | null } {
  if (typeof window === "undefined") return { id: null, expanded: false, viewKey: null };
  const m = /^\/t\/([^/]+)(\/full)?\/?$/.exec(window.location.pathname);
  const viewKey = new URLSearchParams(window.location.search).get("v");
  return { id: m ? decodeURIComponent(m[1]) : null, expanded: m ? Boolean(m[2]) : false, viewKey };
}
// The active board view rides in the URL as ?v=<viewKey> (omitted for the default "all"), so a refresh
// or shared link restores the same view. The selected task still lives in the path (/t/<id>).
function urlFor(id: string | null, expanded: boolean, view: View): string {
  const path = id ? `/t/${encodeURIComponent(id)}${expanded ? "/full" : ""}` : "/";
  const key = viewKey(view);
  return key === "all" ? path : `${path}?v=${encodeURIComponent(key)}`;
}
function paramToView(key: string | null, teams: Team[]): View {
  if (key === "personal") return { kind: "personal" };
  if (key === "needs_input") return { kind: "needs_input" };
  if (key === "review_queue") return { kind: "review_queue" };
  if (key && key.startsWith("team:")) {
    const teamId = key.slice(5);
    return { kind: "team", teamId, name: teams.find((t) => t.id === teamId)?.name ?? "Team" };
  }
  return { kind: "all" };
}

// --- open tabs (Chrome-like workspace) -------------------------------------
// Opened tasks become tabs/pages. The set is persisted so a refresh restores the whole workspace, not
// just the active task (which the URL already carries).
export interface TabRef {
  id: string;
  humanId: string;
  title: string;
}
const TABS_KEY = "be10x.tabs";
function loadTabs(): TabRef[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((t) => t && typeof t.id === "string") : [];
  } catch {
    return [];
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
  /** Tasks opened as tabs in the workspace (the active one is `selectedTaskId`). */
  openTabs: TabRef[];

  setView: (view: View) => void;
  reloadTasks: () => Promise<void>;
  reloadTeams: () => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<Task>;
  createTeam: (name: string) => Promise<Team>;
  moveTask: (taskId: string, to: Status) => Promise<boolean>;
  applyTask: (task: Task) => void;
  selectTask: (id: string | null) => void;
  /** Close a task tab; if it was active, the neighbouring tab (or the board) takes over. */
  closeTab: (id: string) => void;
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
  const [view, setView] = useState<View>(() => paramToView(parseLocation().viewKey, []));
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => parseLocation().id);
  const [expanded, setExpanded] = useState<boolean>(() => parseLocation().expanded);
  const [openTabs, setOpenTabs] = useState<TabRef[]>(() => loadTabs());
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = allTasks;
  const openTabsRef = useRef<TabRef[]>([]);
  openTabsRef.current = openTabs;
  const teamsRef = useRef<Team[]>([]);
  teamsRef.current = teams;

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

  // Reflect the selected task + full-view flag in the URL (deep-linkable, refresh-safe, shareable), and
  // respond to browser back/forward so navigation feels native.
  useEffect(() => {
    const url = urlFor(selectedTaskId, expanded, view);
    const current = window.location.pathname + window.location.search;
    if (current !== url) window.history.pushState(null, "", url);
  }, [selectedTaskId, expanded, view]);

  useEffect(() => {
    const onPop = () => {
      const loc = parseLocation();
      setSelectedTaskId(loc.id);
      setExpanded(loc.expanded);
      setView(paramToView(loc.viewKey, teamsRef.current));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // A team view restored from the URL before teams loaded shows a placeholder name — fill it once loaded.
  useEffect(() => {
    setView((v) =>
      v.kind === "team" ? { ...v, name: teams.find((t) => t.id === v.teamId)?.name ?? v.name } : v,
    );
  }, [teams]);

  // Persist the open tabs so a refresh restores the whole workspace, not just the active task.
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(openTabs));
    } catch {
      /* storage may be unavailable — non-fatal */
    }
  }, [openTabs]);

  // Keep tab labels fresh from the loaded tasks (fills placeholders from a deep link, tracks renames).
  useEffect(() => {
    if (!allTasks.length) return;
    setOpenTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        const task = allTasks.find((x) => x.id === t.id);
        if (task && (task.humanId !== t.humanId || task.title !== t.title)) {
          changed = true;
          return { id: t.id, humanId: task.humanId, title: task.title };
        }
        return t;
      });
      return changed ? next : prev;
    });
  }, [allTasks]);

  // The task in the URL (deep link / refresh) is always represented as an open tab.
  useEffect(() => {
    if (!selectedTaskId) return;
    setOpenTabs((prev) =>
      prev.some((t) => t.id === selectedTaskId)
        ? prev
        : [...prev, { id: selectedTaskId, humanId: "…", title: "Task" }],
    );
  }, [selectedTaskId]);

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
    if (id === null) {
      setExpanded(false);
      return;
    }
    // Opening a task registers (or re-activates) its tab — every card/row already routes through here.
    const task = tasksRef.current.find((t) => t.id === id);
    setOpenTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, humanId: task?.humanId ?? "…", title: task?.title ?? "Task" }],
    );
  }, []);

  const closeTab = useCallback((id: string) => {
    const tabs = openTabsRef.current;
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setOpenTabs(next);
    // Closing the active tab hands off to the neighbour (or the board when none remain).
    setSelectedTaskId((cur) => (cur === id ? next[idx]?.id ?? next[idx - 1]?.id ?? null : cur));
  }, []);

  const expandTask = useCallback(() => setExpanded(true), []);
  const collapseTask = useCallback(() => setExpanded(false), []);

  const resolveActor = useCallback(
    (actorId: string): string => {
      if (actorId === user.id) return user.displayName || "You";
      if (actorId === "agent" || actorId === "worker" || actorId === "runner") return "Agent";
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
    openTabs,
    setView,
    reloadTasks,
    reloadTeams,
    createTask,
    createTeam,
    moveTask,
    applyTask,
    selectTask,
    closeTab,
    expandTask,
    collapseTask,
    logout,
    resolveActor,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

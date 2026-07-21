// ABOUTME: Shared task-detail controller — fetches the task, its events and any open input request,
// exposes a refresh + a governed move, and is consumed by BOTH the slide-over (DetailPanel) and the
// full-screen deep-dive (DeepDivePanel) so they render the same live data without a double fetch.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage, ApiError } from "@/lib/api";
import { STATUS_META } from "@/lib/lifecycle";
import type { InputRequest, Run, Status, Task, TaskEvent } from "@/lib/types";
import { useApp } from "@/state/app-store";

export interface Detail {
  task: Task;
  events: TaskEvent[];
  input: InputRequest | null;
  runs: Run[];
}

// A pending question only matters while the agent is actively working the task. Past that (approved,
// verifying, done, terminal) a still-"open" request is stale — don't surface it as "needs your input".
const INPUT_STATES = new Set<Status>(["researching", "plan_review", "needs_input", "in_progress", "blocked"]);

export interface TaskDetailController {
  detail: Detail | null;
  loading: boolean;
  /** The task couldn't be found (deleted / no access) — the tab is auto-closed. */
  notFound: boolean;
  refresh: () => void;
  onMove: (to: Status) => Promise<void>;
}

export function useTaskDetail(taskId: string | null): TaskDetailController {
  const { applyTask, moveTask, closeTab } = useApp();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(
    async (id: string, opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      try {
        // Always fetch any open question — the agent can ask during planning (researching), not only
        // when the task formally pauses in needs_input, and the human must be able to answer it anytime.
        const [{ task }, { events }, { inputRequest }, { runs }] = await Promise.all([
          api.getTask(id),
          api.events(id),
          api.getInput(id),
          api.listRuns(id),
        ]);
        setDetail({ task, events, input: INPUT_STATES.has(task.status) ? inputRequest : null, runs });
        setNotFound(false);
        applyTask(task);
      } catch (err) {
        // A gone task (deleted/no access) shouldn't spin forever or nag "something went wrong": close the
        // tab and say so plainly. Other errors (network/500) surface a specific message and keep the tab.
        const gone = err instanceof ApiError && (err.status === 404 || err.code === "NO_TASK" || err.code === "NOT_FOUND");
        if (gone) {
          setNotFound(true);
          if (!opts?.silent) toast.error("This task no longer exists — closing it.");
          closeTab(id);
        } else if (!opts?.silent) {
          toast.error(errorMessage(err));
        }
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [applyTask],
  );

  useEffect(() => {
    if (taskId) void load(taskId);
    // Keep the last detail cached while closing so exit animations don't flash the loader;
    // a stale id is guarded by callers via `detail.task.id !== taskId`.
  }, [taskId, load]);

  // Live updates: while a task is open, poll it silently so the agent's progress, plan, questions, and
  // status changes appear on their own — no manual refresh. (v1 will move to a push/URL-aware model.)
  useEffect(() => {
    if (!taskId) return;
    const t = setInterval(() => void load(taskId, { silent: true }), 3000);
    return () => clearInterval(t);
  }, [taskId, load]);

  const refresh = useCallback(() => {
    if (taskId) void load(taskId);
  }, [taskId, load]);

  const onMove = useCallback(
    async (to: Status) => {
      if (!detail) return;
      const ok = await moveTask(detail.task.id, to);
      if (ok) toast.success(`Moved to ${STATUS_META[to].label}.`);
      refresh();
    },
    [detail, moveTask, refresh],
  );

  return { detail, loading, notFound, refresh, onMove };
}

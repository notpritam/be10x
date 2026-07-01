// ABOUTME: Shared task-detail controller — fetches the task, its events and any open input request,
// exposes a refresh + a governed move, and is consumed by BOTH the slide-over (DetailPanel) and the
// full-screen deep-dive (DeepDivePanel) so they render the same live data without a double fetch.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { STATUS_META } from "@/lib/lifecycle";
import type { InputRequest, Status, Task, TaskEvent } from "@/lib/types";
import { useApp } from "@/state/app-store";

export interface Detail {
  task: Task;
  events: TaskEvent[];
  input: InputRequest | null;
}

export interface TaskDetailController {
  detail: Detail | null;
  loading: boolean;
  refresh: () => void;
  onMove: (to: Status) => Promise<void>;
}

export function useTaskDetail(taskId: string | null): TaskDetailController {
  const { applyTask, moveTask } = useApp();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        const [{ task }, { events }] = await Promise.all([api.getTask(id), api.events(id)]);
        let input: InputRequest | null = null;
        if (task.status === "needs_input") {
          input = (await api.getInput(id)).inputRequest;
        }
        setDetail({ task, events, input });
        applyTask(task);
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [applyTask],
  );

  useEffect(() => {
    if (taskId) void load(taskId);
    // Keep the last detail cached while closing so exit animations don't flash the loader;
    // a stale id is guarded by callers via `detail.task.id !== taskId`.
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

  return { detail, loading, refresh, onMove };
}

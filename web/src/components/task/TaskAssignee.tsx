// ABOUTME: Assign a task to a teammate — the control that decides WHICH person's machine runs it (strict
// ABOUTME: assignee-routing). Mirrors the bug assignee picker: recent collaborators + yourself in a Select.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Task, UserLite } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function TaskAssignee({ task, onDone }: { task: Task; onDone: () => void }) {
  const { user } = useApp();
  const [people, setPeople] = useState<UserLite[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api.recentPeople().then((r) => active && setPeople(r.users)).catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const options = useMemo(() => {
    const map = new Map<string, string>();
    map.set(user.id, "Me");
    for (const p of people) if (!map.has(p.id)) map.set(p.id, p.displayName);
    if (task.assigneeId && !map.has(task.assigneeId)) map.set(task.assigneeId, `User ${task.assigneeId.slice(0, 8)}`);
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [people, user.id, task.assigneeId]);

  async function assign(assigneeId: string | null) {
    setSaving(true);
    try {
      await api.assignTask(task.id, assigneeId);
      toast.success(assigneeId ? "Assigned — it'll run on their machine." : "Unassigned.");
      onDone();
    } catch {
      toast.error("Couldn't update the assignee.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-medium text-muted-foreground">Assignee</span>
      <Select
        value={task.assigneeId ?? "unassigned"}
        onValueChange={(v) => void assign(v === "unassigned" ? null : v)}
      >
        <SelectTrigger className="h-9 w-full text-[13px]" disabled={saving}>
          <SelectValue placeholder="Unassigned" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unassigned">Unassigned</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

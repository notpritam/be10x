// ABOUTME: Set / change the project (the repo the agent spawns in) for a task — changeable anytime, so a
// ABOUTME: task starts project-agnostic and you (or the assignee) pick where it runs, and can move it later.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Project, Task } from "@/lib/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function TaskProject({ task, onDone }: { task: Task; onDone: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api.listProjects().then((r) => active && setProjects(r.projects)).catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const options = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.name);
    // The task's current project may not be in your list (e.g. it lives on another machine) — keep it shown.
    if (task.projectId && !map.has(task.projectId)) map.set(task.projectId, "Current project");
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [projects, task.projectId]);

  async function change(projectId: string | null) {
    setSaving(true);
    try {
      await api.setTaskProject(task.id, projectId);
      toast.success(projectId ? "Project set — it'll run there." : "Project cleared.");
      onDone();
    } catch {
      toast.error("Couldn't update the project.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-medium text-muted-foreground">Project (where the agent runs)</span>
      <Select
        value={task.projectId ?? "none"}
        onValueChange={(v) => void change(v === "none" ? null : v)}
      >
        <SelectTrigger className="h-9 w-full text-[13px]" disabled={saving}>
          <SelectValue placeholder="No project" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No project</SelectItem>
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

// ABOUTME: Per-task agent controls — the model and reasoning effort this task runs at, with inline
// toggles. Stored on task.content (model/effort) via patchContent; the executor reads them per run, so a
// change applies from the next run. "Default" clears the override and inherits the server default.
import { useState } from "react";
import { Cpu, Gauge } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import type { Task } from "@/lib/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Model aliases the CLI resolves to the latest of each tier (drift-proof vs. pinning full ids).
const MODELS: { value: string; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "opus", label: "Opus 4.8" },
  { value: "sonnet", label: "Sonnet 5" },
  { value: "haiku", label: "Haiku 4.5" },
];
const EFFORTS: { value: string; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-High" },
  { value: "max", label: "Max" },
];

export function AgentConfigControl({ task, onChanged }: { task: Task; onChanged?: () => void }) {
  const [saving, setSaving] = useState<null | "model" | "effort">(null);
  const model = (typeof task.content?.model === "string" && task.content.model) || "default";
  const effort = (typeof task.content?.effort === "string" && task.content.effort) || "default";

  async function save(field: "model" | "effort", value: string) {
    setSaving(field);
    try {
      // null clears the override (executor falls back to the server default).
      await api.patchContent(task.id, { [field]: value === "default" ? null : value });
      onChanged?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px]">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Cpu className="size-3.5" /> Model
      </span>
      <Select value={model} onValueChange={(v) => void save("model", v)} disabled={saving !== null}>
        <SelectTrigger className="h-7 w-[116px] text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODELS.map((m) => (
            <SelectItem key={m.value} value={m.value} className="text-[12.5px]">
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <span className="ml-1.5 inline-flex items-center gap-1.5 text-muted-foreground">
        <Gauge className="size-3.5" /> Effort
      </span>
      <Select value={effort} onValueChange={(v) => void save("effort", v)} disabled={saving !== null}>
        <SelectTrigger className="h-7 w-[108px] text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {EFFORTS.map((e) => (
            <SelectItem key={e.value} value={e.value} className="text-[12.5px]">
              {e.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <span className="text-[11px] text-muted-foreground/60">applies to the next run</span>
    </div>
  );
}

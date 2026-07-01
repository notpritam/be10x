// ABOUTME: Plan version history — lists the snapshots taken on every plan change (newest first) and
// restores an older one (restore itself snapshots the current plan first). Backend: /api/tasks/:id/plan-versions.
import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { api, type PlanVersion } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function PlanVersions({ taskId, onRestored }: { taskId: string; onRestored: () => void }) {
  const [versions, setVersions] = useState<PlanVersion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listPlanVersions(taskId)
      .then((r) => setVersions(r.versions))
      .catch(() => setVersions([]));
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  async function restore(v: PlanVersion) {
    setBusy(v.id);
    try {
      await api.restorePlanVersion(taskId, v.id);
      toast.success("Plan restored from this version.");
      load();
      onRestored();
    } catch {
      toast.error("Couldn't restore that version.");
    } finally {
      setBusy(null);
    }
  }

  if (versions.length === 0) {
    return <p className="text-[12px] text-muted-foreground">No saved versions yet.</p>;
  }

  return (
    <ul className="mb-3 space-y-1.5">
      {versions.map((v, i) => (
        <li
          key={v.id}
          className="flex items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-1.5 text-[12px]"
        >
          <span className="font-medium text-foreground/90">{i === 0 ? "Current" : `v${versions.length - i}`}</span>
          <span className="text-muted-foreground">· {relativeTime(v.createdAt)}</span>
          {i !== 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy === v.id}
              onClick={() => restore(v)}
              className="ml-auto h-7 gap-1.5 text-[11.5px]"
            >
              <RotateCcw className="size-3.5" /> Restore
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

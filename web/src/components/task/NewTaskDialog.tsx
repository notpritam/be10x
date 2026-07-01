// ABOUTME: Create a task — type, scope (derived from the current view), title, and the summary/symptom
// that satisfies the type's required content field. New tasks land in backlog (backend rule).
import { useEffect, useState, type ReactNode } from "react";
import { Check, Code2, GitBranch, Lightbulb, Loader2, TreePine } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/state/app-store";
import { api, errorMessage } from "@/lib/api";
import type { Isolation, Project, Severity, TaskType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SEVERITIES: Severity[] = ["low", "medium", "high"];
const SEV_LABEL: Record<Severity, string> = { low: "Low", medium: "Medium", high: "High" };

export function NewTaskDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { view, createTask, selectTask } = useApp();
  const [type, setType] = useState<TaskType>("general");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [isolation, setIsolation] = useState<Isolation>("worktree");
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState(false);

  const scope =
    view.kind === "team"
      ? { scope: "team", teamId: view.teamId, label: view.name }
      : { scope: "personal", teamId: null as string | null, label: "Personal" };

  useEffect(() => {
    if (!open) return;
    setType("general");
    setTitle("");
    setDetail("");
    setSeverity("medium");
    setIsolation("worktree");
    setStartNow(true);
    api
      .listProjects()
      .then((r) => {
        setProjects(r.projects);
        setProjectId(r.projects[0]?.id ?? "");
      })
      .catch(() => setProjects([]));
  }, [open]);

  const detailLabel = type === "code-issue" ? "Symptom" : "Summary";
  const detailPlaceholder =
    type === "code-issue"
      ? "What's going wrong? e.g. double submit creates two sessions"
      : "The gist. e.g. outline the key questions for the Q3 brief";
  const canSubmit = title.trim().length > 0 && detail.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const content = type === "code-issue" ? { symptom: detail.trim() } : { summary: detail.trim() };
      const task = await createTask({
        type,
        scope: scope.scope,
        teamId: scope.teamId,
        title: title.trim(),
        content,
        severity,
        projectId: projectId || null,
        isolation,
        handOff: startNow,
      });
      toast.success(startNow ? `${task.humanId} created — handed to the agent.` : `${task.humanId} created.`);
      onOpenChange(false);
      selectTask(task.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-[16px]">New task</DialogTitle>
          <DialogDescription>
            Lands in <span className="font-medium text-foreground">Backlog</span> ·{" "}
            <span className="font-medium text-foreground">{scope.label}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-1">
          {/* Type */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-[12.5px] text-foreground/80">Type</Label>
            <div className="grid grid-cols-2 gap-2">
              <TypeButton
                active={type === "general"}
                onClick={() => setType("general")}
                icon={<Lightbulb className="size-4" />}
                title="General"
                hint="Idea or research"
              />
              <TypeButton
                active={type === "code-issue"}
                onClick={() => setType("code-issue")}
                icon={<Code2 className="size-4" />}
                title="Code issue"
                hint="Bug or defect"
              />
            </div>
          </div>

          {/* Title */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nt-title" className="text-[12.5px] text-foreground/80">
              Title
            </Label>
            <Input
              id="nt-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short, specific name"
              className="h-10 bg-background text-[13.5px]"
            />
          </div>

          {/* Summary / symptom */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nt-detail" className="text-[12.5px] text-foreground/80">
              {detailLabel}
            </Label>
            <Textarea
              id="nt-detail"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder={detailPlaceholder}
              rows={3}
              className="resize-none bg-background text-[13.5px]"
            />
          </div>

          {/* Severity */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-[12.5px] text-foreground/80">Priority</Label>
            <div className="inline-flex gap-1.5">
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverity(s)}
                  className={cn(
                    "h-8 rounded-lg border px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    severity === s
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {SEV_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <div className="h-px bg-border/70" />
          <p className="-mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Agent
          </p>

          {/* Repository — which linked repo the agent works this task in */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-[12.5px] text-foreground/80">Repository</Label>
            <Select value={projectId || "none"} onValueChange={(v) => setProjectId(v === "none" ? "" : v)}>
              <SelectTrigger className="h-10 bg-background text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Personal — any running agent</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {p.key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11.5px] text-muted-foreground">
              {projects.length === 0
                ? "No repos linked yet — run be10x link in a repo. Until then the agent uses whichever runner is up."
                : "The repo the agent works this task in."}
            </p>
          </div>

          {/* Isolation — a fresh worktree, or the repo in place */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-[12.5px] text-foreground/80">Isolation</Label>
            <div className="grid grid-cols-2 gap-2">
              <TypeButton
                active={isolation === "worktree"}
                onClick={() => setIsolation("worktree")}
                icon={<TreePine className="size-4" />}
                title="Worktree"
                hint="Isolated checkout"
              />
              <TypeButton
                active={isolation === "branch"}
                onClick={() => setIsolation("branch")}
                icon={<GitBranch className="size-4" />}
                title="In place"
                hint="Work in the repo"
              />
            </div>
          </div>

          {/* Start the agent immediately (hand-off on create) */}
          <button
            type="button"
            onClick={() => setStartNow((v) => !v)}
            className={cn(
              "flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              startNow ? "border-primary/40 bg-primary/[0.06]" : "border-border bg-background hover:bg-accent/40",
            )}
          >
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-foreground">Start the agent now</span>
              <span className="block text-[11.5px] text-muted-foreground">
                Hand straight to the agent to start planning
              </span>
            </span>
            <span
              className={cn(
                "ml-3 grid size-5 shrink-0 place-items-center rounded-md border transition-colors",
                startNow ? "border-primary bg-primary text-primary-foreground" : "border-border",
              )}
            >
              {startNow ? <Check className="size-3.5" /> : null}
            </span>
          </button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TypeButton({
  active,
  onClick,
  icon,
  title,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "border-primary/40 bg-primary/[0.06]"
          : "border-border bg-background hover:border-border hover:bg-accent/40",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg",
          active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-foreground">{title}</span>
        <span className="block text-[11.5px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

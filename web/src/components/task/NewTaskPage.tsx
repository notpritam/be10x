// ABOUTME: Create a task as a full PAGE (not a modal) — fills the main area at full width in a two-column
// layout (details on the left, agent settings on the right). Type, scope (from the current view), title,
// the type's required content field, priority, repo + isolation, start-now. onCreated opens the new task.
import { useEffect, useState, type ReactNode } from "react";
import { Check, Code2, FolderPlus, GitBranch, Lightbulb, Loader2, MessagesSquare, TreePine, X } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/state/app-store";
import { api, errorMessage } from "@/lib/api";
import type { Isolation, Project, Severity, Task, TaskType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DirectoryPicker } from "./DirectoryPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SEVERITIES: Severity[] = ["low", "medium", "high"];
const SEV_LABEL: Record<Severity, string> = { low: "Low", medium: "Medium", high: "High" };

export function NewTaskPage({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (task: Task) => void;
}) {
  const { view, createTask } = useApp();
  const [type, setType] = useState<TaskType>("general");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isolation, setIsolation] = useState<Isolation>("worktree");
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState(false);

  function onRepoAdded(project: Project) {
    setProjects((prev) => [...prev.filter((p) => p.id !== project.id), project]);
    setProjectId(project.id);
  }

  const scope =
    view.kind === "team"
      ? { scope: "team", teamId: view.teamId, label: view.name }
      : { scope: "personal", teamId: null as string | null, label: "Personal" };

  useEffect(() => {
    api
      .listProjects()
      .then((r) => {
        setProjects(r.projects);
        setProjectId(r.projects[0]?.id ?? "");
      })
      .catch(() => setProjects([]));
  }, []);

  const detailLabel = type === "code-issue" ? "Symptom" : type === "query" ? "Question" : "Summary";
  const detailPlaceholder =
    type === "code-issue"
      ? "What's going wrong? e.g. double submit creates two sessions"
      : type === "query"
        ? "Ask the agent anything — e.g. what's the riskiest part of this repo?"
        : "The gist. e.g. outline the key questions for the Q3 brief";
  const canSubmit = title.trim().length > 0 && detail.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const content =
        type === "code-issue"
          ? { symptom: detail.trim() }
          : type === "query"
            ? { question: detail.trim() }
            : { summary: detail.trim() };
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
      onCreated(task);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin bg-background">
      <div className="w-full px-8 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-bold tracking-[-0.02em] text-foreground">New task</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Lands in <span className="font-medium text-foreground">Backlog</span> ·{" "}
              <span className="font-medium text-foreground">{scope.label}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            title="Cancel"
            className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-[18px]" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-x-12 gap-y-7 lg:grid-cols-2">
          {/* Left — what the task is */}
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <Label className="text-[12.5px] text-foreground/80">Type</Label>
              <div className="grid grid-cols-3 gap-2">
                <TypeButton active={type === "general"} onClick={() => setType("general")} icon={<Lightbulb className="size-4" />} title="General" hint="Idea or research" />
                <TypeButton active={type === "code-issue"} onClick={() => setType("code-issue")} icon={<Code2 className="size-4" />} title="Code issue" hint="Bug or defect" />
                <TypeButton active={type === "query"} onClick={() => setType("query")} icon={<MessagesSquare className="size-4" />} title="Query" hint="Chat with the agent" />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nt-title" className="text-[12.5px] text-foreground/80">Title</Label>
              <Input id="nt-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short, specific name" className="h-10 bg-background text-[13.5px]" />
            </div>

            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="nt-detail" className="text-[12.5px] text-foreground/80">{detailLabel}</Label>
              <Textarea id="nt-detail" value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={detailPlaceholder} rows={6} className="min-h-[120px] flex-1 resize-none bg-background text-[13.5px]" />
            </div>

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
                      severity === s ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {SEV_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Right — how the agent runs it */}
          <div className="flex flex-col gap-5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Agent</p>

            <div className="flex flex-col gap-1.5">
              <Label className="text-[12.5px] text-foreground/80">Repository</Label>
              <Select value={projectId || "none"} onValueChange={(v) => setProjectId(v === "none" ? "" : v)}>
                <SelectTrigger className="h-10 bg-background text-[13px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Personal — any running agent</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name} · {p.key}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div>
                <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                  <FolderPlus className="size-3.5" /> Add a repository…
                </Button>
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                Browse to any git repo on your machine — no terminal, no path typing. The agent works this task there.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-[12.5px] text-foreground/80">Isolation</Label>
              <div className="grid grid-cols-2 gap-2">
                <TypeButton active={isolation === "worktree"} onClick={() => setIsolation("worktree")} icon={<TreePine className="size-4" />} title="Worktree" hint="Isolated checkout" />
                <TypeButton active={isolation === "branch"} onClick={() => setIsolation("branch")} icon={<GitBranch className="size-4" />} title="In place" hint="Work in the repo" />
              </div>
            </div>

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
                <span className="block text-[11.5px] text-muted-foreground">Hand straight to the agent to start planning</span>
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

          {/* Footer spans both columns */}
          <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-5 lg:col-span-2">
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Create task"}
            </Button>
          </div>
        </div>
      </div>
      <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} onAdded={onRepoAdded} />
    </div>
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
        active ? "border-primary/40 bg-primary/[0.06]" : "border-border bg-background hover:border-border hover:bg-accent/40",
      )}
    >
      <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg", active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-foreground">{title}</span>
        <span className="block text-[11.5px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

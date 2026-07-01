// ABOUTME: The agent's live implementation task list — the steps it's breaking the work into, each with
// a status (done / in-progress / pending), so you can see what it's working on and what's left. Fed by
// task.agent.todos (gfa_update_progress); tolerant of plain strings or { text, status } items.
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface TodoItem {
  text: string;
  status?: string;
}

function normalize(t: unknown): TodoItem | null {
  if (typeof t === "string") return t.trim() ? { text: t.trim() } : null;
  if (t && typeof t === "object") {
    const o = t as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : typeof o.title === "string" ? o.title : undefined;
    if (text && text.trim()) return { text: text.trim(), status: typeof o.status === "string" ? o.status : undefined };
  }
  return null;
}

const DONE = new Set(["done", "completed", "complete", "closed"]);
const ACTIVE = new Set(["in_progress", "in-progress", "working", "active", "doing", "started"]);

export function TaskChecklist({ todos }: { todos: unknown }) {
  const items = (Array.isArray(todos) ? todos.map(normalize).filter((x): x is TodoItem => x !== null) : []);
  if (items.length === 0) return null;

  const done = items.filter((i) => i.status && DONE.has(i.status.toLowerCase())).length;

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[12px] font-semibold text-muted-foreground/80">Task list</h3>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {done}/{items.length}
        </span>
      </div>
      <ul className="space-y-1.5 rounded-[8px] border border-border/60 bg-card p-3">
        {items.map((it, i) => {
          const s = (it.status ?? "").toLowerCase();
          const isDone = DONE.has(s);
          const isActive = ACTIVE.has(s);
          return (
            <li key={i} className="flex items-start gap-2 text-[13px]">
              <span className="mt-0.5 shrink-0">
                {isDone ? (
                  <CheckCircle2 className="size-4 text-emerald-600" />
                ) : isActive ? (
                  <Loader2 className="size-4 animate-spin text-primary" />
                ) : (
                  <Circle className="size-4 text-muted-foreground/40" />
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 leading-snug",
                  isDone ? "text-muted-foreground line-through" : isActive ? "font-medium text-foreground" : "text-foreground/90",
                )}
              >
                {it.text}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

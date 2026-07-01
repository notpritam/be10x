// ABOUTME: Shared presentational atoms for the task views — the meta bits, move buttons, content
// renderer, agent block and the header icon button. Extracted from DetailPanel so the slide-over and
// the full-screen deep-dive render byte-for-byte identical, on-brand pieces.
import type { ReactNode } from "react";
import { Bot, Loader2 } from "lucide-react";
import { legalMoves, STATUS_META } from "@/lib/lifecycle";
import type { Status, Task } from "@/lib/types";
import { humanizeKey, isRecord } from "@/lib/utils";

export function ownerName(
  task: Task,
  userId: string,
  displayName: string,
  resolveActor: (id: string) => string,
): string {
  const id = task.assigneeId ?? task.ownerId;
  return id === userId ? displayName : resolveActor(id);
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold text-muted-foreground/80">{title}</h3>
      {children}
    </section>
  );
}

export function StatusBadge({ status }: { status: Status }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-[12px] font-semibold text-foreground">
      <span className="size-2 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

export function MoveButtons({ status, onMove }: { status: Status; onMove: (to: Status) => void }) {
  const moves = legalMoves(status);
  if (moves.length === 0) {
    return (
      <div className="rounded-xl border border-border/70 bg-card px-3.5 py-3 text-[12.5px] text-muted-foreground">
        This task is closed. No further moves.
      </div>
    );
  }
  return (
    <Section title="Move to">
      <div className="flex flex-wrap gap-2">
        {moves.map((to) => (
          <button
            key={to}
            type="button"
            onClick={() => onMove(to)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="size-2 rounded-full" style={{ background: STATUS_META[to].color }} />
            {STATUS_META[to].moveVerb}
          </button>
        ))}
      </div>
    </Section>
  );
}

export function TaskContent({ task }: { task: Task }) {
  const content = task.content ?? {};
  const primaryKey = task.type === "code-issue" ? "symptom" : "summary";
  const entries = Object.entries(content).filter(([, v]) => v != null && v !== "");
  const primary = entries.find(([k]) => k === primaryKey);
  const rest = entries.filter(([k]) => k !== primaryKey);

  if (entries.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No details yet.</p>;
  }

  return (
    <div className="space-y-3.5">
      {primary && (
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-foreground/90">
          {String(primary[1])}
        </p>
      )}
      {rest.map(([k, v]) => (
        <div key={k}>
          <p className="mb-1 text-[11.5px] font-medium text-muted-foreground">{humanizeKey(k)}</p>
          <DataValue value={v} />
        </div>
      ))}
    </div>
  );
}

export function DataValue({ value }: { value: unknown }): ReactNode {
  if (value == null) return null;
  if (typeof value === "string") {
    return (
      <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/90">{value}</p>
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <p className="text-[13.5px] text-foreground/90">{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    return (
      <ul className="ml-4 list-disc space-y-1 text-[13.5px] leading-relaxed text-foreground/90 marker:text-muted-foreground/50">
        {value.map((v, i) => (
          <li key={i}>
            <DataValue value={v} />
          </li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) {
    return (
      <div className="space-y-1.5">
        {Object.entries(value).map(([k, v]) => (
          <div key={k} className="text-[13px]">
            <span className="font-medium text-muted-foreground">{humanizeKey(k)}: </span>
            <span className="text-foreground/90">
              {typeof v === "string" ? v : JSON.stringify(v)}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

export function AgentStatusBlock({ task }: { task: Task }) {
  const agent = task.agent;
  if (!agent) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card px-3.5 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Bot className="size-4" />
        </span>
        <div className="text-[12.5px] leading-snug">
          <p className="font-medium text-foreground">No agent assigned yet</p>
          <p className="text-muted-foreground">
            {task.type === "code-issue"
              ? "An agent can pick this up once the plan is approved."
              : "This type runs with a human in the loop."}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card px-3.5 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
        <Bot className="size-4" />
      </span>
      <div className="min-w-0 text-[12.5px] leading-snug">
        <p className="font-semibold text-foreground">{agent.name ?? "Agent"}</p>
        <p className="text-muted-foreground">
          {[agent.state, agent.model].filter(Boolean).join(" · ") || "Working"}
        </p>
      </div>
      {task.retryCount > 0 && (
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {task.retryCount} {task.retryCount === 1 ? "retry" : "retries"}
        </span>
      )}
    </div>
  );
}

export function RefreshingHint() {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" /> Refreshing…
    </div>
  );
}

export function PanelLoading() {
  return (
    <div className="flex h-full items-center justify-center py-16">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Quiet ghost icon button used in the panel headers (expand / collapse / close). */
export function HeaderIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {children}
    </button>
  );
}

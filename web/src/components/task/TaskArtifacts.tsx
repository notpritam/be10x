// ABOUTME: The agent's visual artifacts on a task — RCA, diagrams, findings, suggestions, verification —
// rendered richly (HTML in a sandbox, via PlanView) so the human grasps what's going on at a glance. This
// is the heart of the task view: visuals over prose. Each artifact is collapsible; newest first.
import { useState } from "react";
import {
  ChevronDown,
  FileText,
  GitBranch,
  Lightbulb,
  ListChecks,
  ShieldCheck,
  SearchCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { Artifact } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";
import { PlanView } from "./PlanView";

// Per-kind icon + label + accent, so an RCA reads differently from a suggestion at a glance.
const KIND: Record<string, { icon: LucideIcon; label: string; accent: string }> = {
  rca: { icon: SearchCheck, label: "Root cause", accent: "text-red-600" },
  diagram: { icon: GitBranch, label: "Diagram", accent: "text-primary" },
  finding: { icon: Lightbulb, label: "Finding", accent: "text-amber-600" },
  suggestion: { icon: Sparkles, label: "Suggestion", accent: "text-primary" },
  verification: { icon: ShieldCheck, label: "Verification", accent: "text-emerald-600" },
  doc: { icon: FileText, label: "Doc", accent: "text-muted-foreground" },
  note: { icon: ListChecks, label: "Note", accent: "text-muted-foreground" },
};

function meta(kind: string) {
  return KIND[kind?.toLowerCase?.()] ?? KIND.note;
}

function ArtifactCard({ a }: { a: Artifact }) {
  const [open, setOpen] = useState(true);
  const { icon: Icon, label, accent } = meta(a.kind);
  const when = a.updatedAt ?? a.createdAt;
  return (
    <div className="overflow-hidden rounded-[8px] border border-border/60 bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        <Icon className={cn("size-4 shrink-0", accent)} />
        <span className="text-[12.5px] font-semibold text-foreground">{a.title || label}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {when && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/60">{relativeTime(when)}</span>}
      </button>
      {open && (
        <div className="border-t border-border/50 px-3 py-3">
          <PlanView plan={a.content} />
        </div>
      )}
    </div>
  );
}

export function TaskArtifacts({ artifacts }: { artifacts?: Artifact[] }) {
  const items = Array.isArray(artifacts) ? artifacts : [];
  if (items.length === 0) return null;
  // Newest first — the latest finding/RCA leads.
  const ordered = [...items].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));

  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2">
        <h3 className="text-[12px] font-semibold text-muted-foreground/80">Findings &amp; artifacts</h3>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {ordered.length}
        </span>
      </div>
      <div className="space-y-2">
        {ordered.map((a) => (
          <ArtifactCard key={a.key} a={a} />
        ))}
      </div>
    </section>
  );
}

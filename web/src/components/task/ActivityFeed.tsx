// ABOUTME: Activity feed rendered from GET /api/tasks/:id/events — a compact timeline of what happened.
import { type CSSProperties, type ReactNode, useMemo } from "react";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  CornerDownLeft,
  MessageCircle,
  MessageCircleQuestion,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Star,
  Package,
  GitPullRequestArrow,
  Dot,
  type LucideIcon,
} from "lucide-react";
import type { Status, TaskEvent } from "@/lib/types";
import { STATUS_META } from "@/lib/lifecycle";
import { cn, relativeTime } from "@/lib/utils";

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function clip(v: unknown, n = 160): string | undefined {
  const s = asString(v);
  return s && s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function describe(event: TaskEvent): { icon: LucideIcon; phrase: ReactNode; tone?: "accent" } {
  const p = event.payload ?? {};
  switch (event.kind) {
    case "created":
      return { icon: Plus, phrase: <>created this task</> };
    case "status": {
      const to = p.to as Status | undefined;
      return {
        icon: ArrowRight,
        phrase: (
          <>
            moved to <b className="font-semibold text-foreground">{to ? STATUS_META[to]?.label ?? to : "a new state"}</b>
          </>
        ),
      };
    }
    case "plan":
      return { icon: ClipboardList, phrase: <>updated the plan</> };
    case "research":
      return { icon: Search, phrase: <>added research</> };
    case "content":
      return { icon: Pencil, phrase: <>edited the details</> };
    case "retry":
      return { icon: RotateCw, phrase: <>retried the task</> };
    case "rating":
      return { icon: Star, phrase: <>rated the result</> };
    case "ship":
      return { icon: Package, phrase: <>shipped references</> };
    case "input_request":
      return {
        icon: MessageCircleQuestion,
        phrase: (
          <>
            asked: <span className="text-foreground">{asString(p.question) ?? "a question"}</span>
          </>
        ),
        tone: "accent",
      };
    case "input_answer":
      return {
        icon: CornerDownLeft,
        phrase: (
          <>
            answered: <span className="text-foreground">{asString(p.answer) ?? ""}</span>
          </>
        ),
        tone: "accent",
      };
    case "review":
      return {
        icon: p.verdict === "approved" ? CheckCircle2 : GitPullRequestArrow,
        phrase: p.verdict === "approved" ? <>approved the plan</> : <>requested changes</>,
      };
    case "review_requested":
      return { icon: GitPullRequestArrow, phrase: <>requested a review</> };
    case "progress": {
      const step = asString(p.step);
      const msg = clip(p.message);
      return {
        icon: Activity,
        phrase: (
          <>
            {step ? <b className="font-semibold text-foreground">{step}</b> : <>working</>}
            {msg ? <span className="text-foreground/90"> — {msg}</span> : null}
          </>
        ),
      };
    }
    case "comment":
      return {
        icon: MessageCircle,
        phrase: (
          <>
            commented: <span className="text-foreground">{clip(p.body)}</span>
          </>
        ),
        tone: "accent",
      };
    default:
      return { icon: Dot, phrase: <>{event.kind.replace(/_/g, " ")}</> };
  }
}

export function ActivityFeed({
  events,
  resolveActor,
}: {
  events: TaskEvent[];
  resolveActor: (id: string) => string;
}) {
  const ordered = useMemo(() => [...events].reverse(), [events]);

  if (ordered.length === 0) {
    return <p className="text-[12.5px] text-muted-foreground">No activity yet.</p>;
  }

  return (
    <ol className="relative flex flex-col gap-3.5">
      {/* connecting rail */}
      <span className="absolute bottom-2 left-[13px] top-2 w-px bg-border" aria-hidden />
      {ordered.map((event, i) => {
        const actorName = resolveActor(event.actor);
        const { icon: Icon, phrase, tone } = describe(event);
        return (
          <li
            key={event.id}
            className="feed-in relative flex gap-3"
            style={{ "--stagger": Math.min(i, 12) } as CSSProperties}
          >
            <span
              className={cn(
                "z-10 mt-0.5 grid size-[26px] shrink-0 place-items-center rounded-full border bg-card",
                tone === "accent" ? "border-primary/30 text-primary" : "border-border text-muted-foreground",
              )}
            >
              <Icon className="size-[13px]" />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-[12.5px] leading-snug text-muted-foreground">
                <b className="font-semibold text-foreground">{actorName}</b> {phrase}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">{relativeTime(event.createdAt)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ABOUTME: Small shared presentational atoms — assignee avatar, priority pill, status dot, type tag,
// and the "needs input" badge. Kept deliberately quiet and sentence-case (no shouty caps).
import { Code2, Lightbulb, MessageCircleQuestion } from "lucide-react";
import type { Severity, Status, TaskType } from "@/lib/types";
import { STATUS_META } from "@/lib/lifecycle";
import { avatarHue, cn, initials } from "@/lib/utils";

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      className={cn("inline-block size-2.5 shrink-0 rounded-full", className)}
      style={{ background: STATUS_META[status].color }}
    />
  );
}

const SEVERITY_LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };

export function PriorityPill({ severity }: { severity: Severity }) {
  return (
    <span className={cn("pill-priority", `pill-${severity}`)}>{SEVERITY_LABEL[severity]}</span>
  );
}

export function TypeTag({ type, className }: { type: TaskType; className?: string }) {
  const Icon = type === "code-issue" ? Code2 : Lightbulb;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3.5 opacity-70" />
      {type === "code-issue" ? "Code issue" : "General"}
    </span>
  );
}

export function NeedsInputBadge({ className }: { className?: string }) {
  return (
    <span className={cn("badge-needs-input", className)}>
      <MessageCircleQuestion className="size-3.5" />
      Needs input
    </span>
  );
}

export function UserAvatar({
  name,
  seed,
  size = 24,
  className,
  ring = true,
}: {
  name: string;
  seed: string;
  size?: number;
  className?: string;
  ring?: boolean;
}) {
  const hue = avatarHue(seed);
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold text-white select-none",
        ring && "ring-2 ring-card",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: `linear-gradient(150deg, hsl(${hue} 58% 58%), hsl(${(hue + 24) % 360} 56% 48%))`,
      }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

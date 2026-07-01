// ABOUTME: Reviewer assignment for a TEAM task — pick a teammate and POST review/request {reviewerId},
// which tags them as reviewer and moves the task to plan_review (into their review queue). Only shown
// for team tasks that can still reach plan_review; personal tasks keep the existing self-review flow
// (the "Send to plan review" move + the ReviewActions gate).
import { useCallback, useState } from "react";
import { ChevronDown, GitPullRequestArrow, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { canTransition } from "@/lib/lifecycle";
import type { Member, Task } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { UserAvatar } from "@/components/common/bits";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function memberName(m: Member): string {
  if (m.displayName) return m.displayName;
  if (m.email) return m.email.split("@")[0];
  return "Unknown";
}

export function RequestReviewControl({ task, onDone }: { task: Task; onDone: () => void }) {
  const { user, teams } = useApp();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);

  const teamName = teams.find((t) => t.id === task.teamId)?.name;

  const load = useCallback(async () => {
    if (!task.teamId) return;
    setError(null);
    setMembers(null);
    try {
      const { members } = await api.listMembers(task.teamId);
      setMembers(members);
    } catch (err) {
      setError(errorMessage(err));
      setMembers([]);
    }
  }, [task.teamId]);

  // Team tasks only, and only while plan_review is still reachable.
  if (!task.teamId || !canTransition(task.status, "plan_review")) return null;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && members === null) void load();
  }

  async function assign(m: Member) {
    setAssigningId(m.userId);
    try {
      await api.requestReview(task.id, m.userId);
      toast.success(
        m.userId === user.id
          ? "Sent to plan review. It's in your review queue."
          : `Review requested from ${memberName(m)}.`,
      );
      setOpen(false);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAssigningId(null);
    }
  }

  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold text-muted-foreground/80">Review</h3>
      <div className="rounded-xl border border-border/70 bg-card p-3.5">
        <div className="mb-1 flex items-center gap-2">
          <GitPullRequestArrow className="size-4 text-muted-foreground" />
          <h4 className="text-[13px] font-bold text-foreground">Ready for review?</h4>
        </div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
          Pick a reviewer{teamName ? ` from ${teamName}` : ""}. It moves to plan review and lands in
          their review queue.
        </p>

        <DropdownMenu open={open} onOpenChange={onOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-[12.5px] font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <GitPullRequestArrow className="size-4" />
              Request review
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="text-muted-foreground">Assign a reviewer</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {members === null && !error ? (
              <div className="flex items-center gap-2 px-2 py-2 text-[12.5px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading team…
              </div>
            ) : error ? (
              <div className="px-2 py-2 text-[12.5px] text-muted-foreground">
                Couldn't load members.
              </div>
            ) : members!.length === 0 ? (
              <div className="px-2 py-2 text-[12.5px] text-muted-foreground">No members yet.</div>
            ) : (
              members!.map((m) => {
                const name = memberName(m);
                const isSelf = m.userId === user.id;
                return (
                  <button
                    key={m.userId}
                    type="button"
                    disabled={assigningId !== null}
                    onClick={() => void assign(m)}
                    className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:opacity-60"
                  >
                    <UserAvatar name={name} seed={m.userId} size={24} ring={false} />
                    <span className="min-w-0 flex-1 truncate">
                      {name}
                      {isSelf && (
                        <span className="ml-1 text-[11px] text-muted-foreground">· you</span>
                      )}
                    </span>
                    {assigningId === m.userId && (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                    )}
                  </button>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </section>
  );
}

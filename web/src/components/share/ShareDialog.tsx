// ABOUTME: Mint & manage shareable, permissioned plan-review links for a task. The owner picks what the
// ABOUTME: bearer may do (comment/review only, or also run the agent), creates a link, copies its public
// ABOUTME: URL, and revokes links they no longer want live — each action confirms via a toast.
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { Check, Copy, Link2, Loader2, MessagesSquare, Play, Share2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, type ShareLink, type SharePermission } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PERMISSIONS: {
  value: SharePermission;
  label: string;
  hint: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  {
    value: "comment_only",
    label: "Comment only",
    hint: "View the plan, leave comments, and submit a review.",
    icon: MessagesSquare,
  },
  {
    value: "run_agent",
    label: "Can run the agent",
    hint: "Everything above, plus start the agent on this task.",
    icon: Play,
  },
];

function shareUrl(token: string): string {
  return `${location.origin}/share/${token}`;
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => toast.error("Couldn't copy to clipboard."));
  }, []);
  return [copied, copy];
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function ShareDialog({
  taskId,
  open,
  onOpenChange,
}: {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [permission, setPermission] = useState<SharePermission>("comment_only");
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ShareLink | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { shares } = await api.listShares(taskId);
      setLinks(shares);
    } catch {
      setLinks([]);
    }
  }, [taskId]);

  useEffect(() => {
    if (!open) return;
    setPermission("comment_only");
    setCreated(null);
    setLinks(null);
    void load();
  }, [open, load]);

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      const { share } = await api.createShareLink(taskId, permission);
      setCreated(share);
      await load();
      toast.success("Share link created. Copy it below.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: string) {
    setRevoking(token);
    try {
      await api.revokeShare(token);
      if (created?.token === token) setCreated(null);
      await load();
      toast.success("Link revoked. It no longer works.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRevoking(null);
    }
  }

  const active = (links ?? []).filter((l) => l.revoked_at == null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]">
        <DialogHeader className="border-b border-border/70 px-6 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <span className="grid size-7 place-items-center rounded-lg bg-primary/12 text-primary">
              <Share2 className="size-4" />
            </span>
            Share for review
          </DialogTitle>
          <DialogDescription>
            Create a link that hands this task's plan and discussion to an outside reviewer — no account
            needed. Anyone with the link gets exactly what you allow.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[72vh] flex-col overflow-y-auto scroll-thin px-6 py-5">
          {/* Permission chooser */}
          <p className="mb-2 text-[12px] font-medium text-foreground/80">What can the reviewer do?</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {PERMISSIONS.map((p) => {
              const isActive = permission === p.value;
              const Icon = p.icon;
              return (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setPermission(p.value)}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-[12px] border p-3 text-left transition-colors",
                    isActive
                      ? "border-primary/60 bg-primary/[0.05] ring-1 ring-primary/25"
                      : "border-border/60 bg-card hover:bg-accent/50",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                    <Icon className={cn("size-3.5", isActive ? "text-primary" : "text-muted-foreground")} />
                    {p.label}
                  </span>
                  <span className="text-[11.5px] leading-snug text-muted-foreground">{p.hint}</span>
                </button>
              );
            })}
          </div>

          <Button onClick={() => void create()} disabled={creating} className="mt-3 h-9 w-full text-[13px]">
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <>
                <Link2 className="size-4" />
                Create share link
              </>
            )}
          </Button>

          {/* Freshly created link — prominent, copyable */}
          {created && (
            <div className="mt-4 rounded-[12px] border border-primary/30 bg-primary/[0.04] p-4 soft-fade">
              <div className="mb-2 flex items-center gap-2">
                <Check className="size-4 text-primary" />
                <h3 className="text-[13px] font-bold text-foreground">Your share link is ready</h3>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                  {shareUrl(created.token)}
                </code>
                <CopyButton text={shareUrl(created.token)} label="Copy link" />
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground/80">
                {created.permission === "run_agent"
                  ? "The holder can comment, review, and run the agent."
                  : "The holder can comment and review only."}
              </p>
            </div>
          )}

          {/* Existing active links */}
          <div className="mt-6">
            <h3 className="mb-2.5 text-[12px] font-semibold text-muted-foreground/80">Active links</h3>
            {links === null ? (
              <div className="flex items-center gap-2 py-4 text-[12.5px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading links…
              </div>
            ) : active.length === 0 ? (
              <p className="rounded-[12px] border border-dashed border-border/70 px-3.5 py-6 text-center text-[12.5px] text-muted-foreground/70">
                No active links. Create one above to share this task.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {active.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center gap-3 rounded-[12px] border border-border/60 bg-card px-3 py-2.5"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      {l.permission === "run_agent" ? (
                        <Play className="size-4" />
                      ) : (
                        <MessagesSquare className="size-4" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[12px] text-foreground">{shareUrl(l.token)}</p>
                      <p className="truncate text-[11.5px] text-muted-foreground">
                        {l.permission === "run_agent" ? "Can run the agent" : "Comment only"} · created{" "}
                        {relativeTime(l.created_at)}
                      </p>
                    </div>
                    <CopyButton text={shareUrl(l.token)} />
                    <button
                      type="button"
                      onClick={() => void revoke(l.token)}
                      disabled={revoking === l.token}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:opacity-50"
                    >
                      {revoking === l.token ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

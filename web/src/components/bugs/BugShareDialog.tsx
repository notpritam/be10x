// ABOUTME: Mint & manage public, read-only share links for a QA bug. The owner creates a link, copies its
// ABOUTME: /b/<token> URL, and revokes links they no longer want live — each action confirms via a toast.
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Link2, Loader2, Share2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, type BugShareLink } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function bugShareUrl(token: string): string {
  return `${location.origin}/b/${token}`;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => toast.error("Couldn't copy to clipboard."));
  }, [text]);
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function BugShareDialog({
  bugId,
  open,
  onOpenChange,
}: {
  bugId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [links, setLinks] = useState<BugShareLink[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<BugShareLink | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { shares } = await api.listBugShares(bugId);
      setLinks(shares);
    } catch {
      setLinks([]);
    }
  }, [bugId]);

  useEffect(() => {
    if (!open) return;
    setCreated(null);
    setLinks(null);
    void load();
  }, [open, load]);

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      const { share } = await api.createBugShare(bugId);
      setCreated(share);
      await load();
      toast.success("Public link created. Copy it below.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: string) {
    setRevoking(token);
    try {
      await api.revokeBugShare(token);
      if (created?.token === token) setCreated(null);
      await load();
      toast.success("Link revoked. It no longer works.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRevoking(null);
    }
  }

  const active = (links ?? []).filter((l) => l.revokedAt == null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]">
        <DialogHeader className="border-b border-border/70 px-6 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <span className="grid size-7 place-items-center rounded-lg bg-primary/12 text-primary">
              <Share2 className="size-4" />
            </span>
            Share this bug
          </DialogTitle>
          <DialogDescription>
            Create a public, read-only link to this bug — no account needed. Anyone with the link sees the
            full capture: replay, snapshot, network, and details.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[72vh] flex-col overflow-y-auto scroll-thin px-6 py-5">
          <Button onClick={() => void create()} disabled={creating} className="h-9 w-full text-[13px]">
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <>
                <Link2 className="size-4" />
                Create public link
              </>
            )}
          </Button>

          {/* Freshly created link — prominent, copyable */}
          {created && (
            <div className="mt-4 rounded-[12px] border border-primary/30 bg-primary/[0.04] p-4 soft-fade">
              <div className="mb-2 flex items-center gap-2">
                <Check className="size-4 text-primary" />
                <h3 className="text-[13px] font-bold text-foreground">Your public link is ready</h3>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                  {bugShareUrl(created.token)}
                </code>
                <CopyButton text={bugShareUrl(created.token)} label="Copy link" />
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground/80">
                Anyone with this link can view the full bug — read only.
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
                No active links. Create one above to share this bug.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {active.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center gap-3 rounded-[12px] border border-border/60 bg-card px-3 py-2.5"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <Link2 className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[12px] text-foreground">{bugShareUrl(l.token)}</p>
                      <p className="truncate text-[11.5px] text-muted-foreground">
                        Read only · created {relativeTime(l.createdAt)}
                      </p>
                    </div>
                    <CopyButton text={bugShareUrl(l.token)} />
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

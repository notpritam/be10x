// ABOUTME: The PUBLIC, token-scoped review page. A reviewer who holds a share link lands here (no account):
// ABOUTME: they read the plan + discussion, leave comments and a verdict, optionally ask the owner's agent
// ABOUTME: to pick the task up, and can copy the task/plan JSON onto their own board. Self-contained layout.
import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  CheckCircle2,
  ClipboardCopy,
  Copy,
  CopyPlus,
  Loader2,
  MessageSquarePlus,
  PencilLine,
  Play,
  Send,
  Share2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError, api, errorMessage, type ShareView, type ShareVerdict } from "@/lib/api";
import { STATUS_META } from "@/lib/lifecycle";
import { avatarHue, initials, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PlanView } from "@/components/task/PlanView";

const NAME_KEY = "be10x_share_author";

const VERDICTS: {
  value: ShareVerdict;
  label: string;
  icon: ComponentType<{ className?: string }>;
  variant: "default" | "outline" | "destructive";
  toast: string;
}[] = [
  { value: "approved", label: "Approve", icon: CheckCircle2, variant: "default", toast: "Approved. Thanks for reviewing." },
  { value: "changes_requested", label: "Request changes", icon: PencilLine, variant: "outline", toast: "Changes requested." },
  { value: "rejected", label: "Reject", icon: XCircle, variant: "destructive", toast: "Rejected." },
];

const CARD = "rounded-[12px] border border-border/60 bg-white shadow-sm";

function Chip({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-0.5 text-[11.5px] font-medium text-foreground/80">
      {color && <span className="size-2 rounded-full" style={{ backgroundColor: color }} />}
      {children}
    </span>
  );
}

export function ShareReviewPage({ token }: { token: string }) {
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [view, setView] = useState<ShareView | null>(null);
  const [author, setAuthor] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const [runMsg, setRunMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [runBlocked, setRunBlocked] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(NAME_KEY, author);
    } catch {
      /* ignore */
    }
  }, [author]);

  useEffect(() => {
    let active = true;
    setState("loading");
    api
      .getShare(token)
      .then((v) => {
        if (!active) return;
        setView(v);
        setState("ready");
        document.title = `Review · ${v.task.title}`;
      })
      .catch(() => active && setState("error"));
    return () => {
      active = false;
    };
  }, [token]);

  const refresh = useCallback(async () => {
    try {
      setView(await api.getShare(token));
    } catch {
      /* keep the last good view on a transient error */
    }
  }, [token]);

  const who = () => author.trim() || "guest";

  async function submitReview(verdict: (typeof VERDICTS)[number]) {
    if (busy) return;
    setBusy(verdict.value);
    try {
      await api.shareReview(token, verdict.value, note.trim(), who());
      setNote("");
      toast.success(verdict.toast);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function postComment() {
    const body = comment.trim();
    if (!body || busy) return;
    setBusy("comment");
    try {
      await api.shareComment(token, who(), body);
      setComment("");
      toast.success("Comment posted.");
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function runAgent() {
    if (busy) return;
    setBusy("run");
    try {
      await api.shareRunAgent(token, runMsg.trim(), who());
      setRunMsg("");
      toast.success("Sent — the agent will pick this task up.");
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.code === "FORBIDDEN")) {
        setRunBlocked(true);
        toast.error("This link is comment-only — running the agent isn't allowed.");
      } else {
        toast.error(errorMessage(err));
      }
    } finally {
      setBusy(null);
    }
  }

  function copyJson(text: string, msg: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(msg))
      .catch(() => toast.error("Couldn't copy to clipboard."));
  }

  if (state === "loading") {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 text-muted-foreground">
        <div className="flex items-center gap-2 text-[13px]">
          <Loader2 className="size-4 animate-spin" /> Loading shared task…
        </div>
      </div>
    );
  }

  if (state === "error" || !view) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 px-6">
        <div className={`${CARD} max-w-md p-8 text-center`}>
          <div className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
            <Share2 className="size-5" />
          </div>
          <h1 className="text-[16px] font-semibold text-foreground">This link isn't available</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            The share link is invalid or was revoked. Ask whoever shared it for a fresh link.
          </p>
        </div>
      </div>
    );
  }

  const { task, plan, comments } = view;
  const statusMeta = STATUS_META[task.status];

  return (
    <div className="min-h-screen bg-muted/30 py-8 sm:py-12">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 sm:px-6">
        {/* Header */}
        <header className={`${CARD} p-5 sm:p-6`}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                <Share2 className="size-3.5" /> Shared for review
              </p>
              <h1 className="text-[19px] font-semibold leading-tight text-foreground">{task.title}</h1>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Chip>{task.humanId}</Chip>
                <Chip color={statusMeta?.color}>{statusMeta?.label ?? task.status}</Chip>
                <Chip>{task.type}</Chip>
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="text-[12.5px]"
                onClick={() => copyJson(JSON.stringify(task, null, 2), "Task copied to clipboard.")}
              >
                <Copy className="size-3.5" /> Copy task
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-[12.5px]"
                onClick={() =>
                  copyJson(
                    JSON.stringify({ task, plan }, null, 2),
                    "Task + plan copied — paste it onto your board.",
                  )
                }
              >
                <CopyPlus className="size-3.5" /> Clone task
              </Button>
            </div>
          </div>

          {/* Identity — used to sign everything below */}
          <div className="mt-5 border-t border-border/60 pt-4">
            <label htmlFor="share-author" className="mb-1.5 block text-[12px] font-medium text-foreground/80">
              Reviewing as
            </label>
            <Input
              id="share-author"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Your name"
              className="h-9 max-w-xs bg-white text-[13px]"
            />
            <p className="mt-1.5 text-[11.5px] text-muted-foreground/80">
              Signs your comments and review. Leave blank to post as “guest”.
            </p>
          </div>
        </header>

        {/* Plan */}
        <section className={`${CARD} p-5 sm:p-6`}>
          <h2 className="mb-3 text-[13px] font-semibold text-foreground">Plan</h2>
          {plan == null ? (
            <p className="rounded-[12px] border border-dashed border-border/70 px-3.5 py-6 text-center text-[12.5px] text-muted-foreground/70">
              No plan has been written for this task yet.
            </p>
          ) : (
            <PlanView plan={plan} />
          )}
        </section>

        {/* Review */}
        <section className={`${CARD} p-5 sm:p-6`}>
          <h2 className="text-[13px] font-semibold text-foreground">Your review</h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Leave a verdict. Add an optional note the team will see on the task.
          </p>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for your verdict…"
            className="mt-3 min-h-20 bg-white text-[13px]"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {VERDICTS.map((v) => {
              const Icon = v.icon;
              return (
                <Button
                  key={v.value}
                  variant={v.variant}
                  onClick={() => void submitReview(v)}
                  disabled={busy != null}
                  className="text-[13px]"
                >
                  {busy === v.value ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
                  {v.label}
                </Button>
              );
            })}
          </div>
        </section>

        {/* Run the agent */}
        <section className={`${CARD} p-5 sm:p-6`}>
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
            <Play className="size-3.5 text-primary" /> Run in your session
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Ask the owner's agent to pick this task up now. Requires a link that allows running the agent.
          </p>
          {runBlocked ? (
            <p className="mt-3 rounded-[12px] border border-amber-300/60 bg-amber-50 px-3.5 py-3 text-[12.5px] text-amber-800">
              This link is comment-only — running the agent isn't allowed. Ask for a “can run the agent”
              link if you need this.
            </p>
          ) : (
            <>
              <Textarea
                value={runMsg}
                onChange={(e) => setRunMsg(e.target.value)}
                placeholder="Optional message for the agent…"
                className="mt-3 min-h-16 bg-white text-[13px]"
              />
              <Button
                onClick={() => void runAgent()}
                disabled={busy != null}
                className="mt-3 text-[13px]"
              >
                {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                Run in your session
              </Button>
            </>
          )}
        </section>

        {/* Discussion */}
        <section className={`${CARD} p-5 sm:p-6`}>
          <h2 className="text-[13px] font-semibold text-foreground">
            Discussion{comments.length > 0 && <span className="text-muted-foreground"> · {comments.length}</span>}
          </h2>

          {comments.length === 0 ? (
            <p className="mt-3 rounded-[12px] border border-dashed border-border/70 px-3.5 py-6 text-center text-[12.5px] text-muted-foreground/70">
              No comments yet. Start the conversation below.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-4">
              {comments.map((c) => (
                <li key={c.id} className="flex gap-3">
                  <span
                    className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
                    style={{ backgroundColor: `hsl(${avatarHue(c.author)} 52% 45%)` }}
                  >
                    {initials(c.author)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2">
                      <span className="text-[12.5px] font-semibold text-foreground">{c.author}</span>
                      <span className="text-[11px] text-muted-foreground">{relativeTime(c.createdAt)}</span>
                    </p>
                    <p className="whitespace-pre-wrap text-[13px] leading-snug text-foreground/85">{c.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Composer */}
          <div className="mt-4 border-t border-border/60 pt-4">
            <label htmlFor="share-comment" className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-foreground/80">
              <MessageSquarePlus className="size-3.5" /> Add a comment
            </label>
            <Textarea
              id="share-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void postComment();
                }
              }}
              placeholder="Share feedback, questions, or direction…"
              className="min-h-20 bg-white text-[13px]"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground/70">⌘/Ctrl + Enter to post</span>
              <Button
                onClick={() => void postComment()}
                disabled={busy != null || !comment.trim()}
                className="text-[13px]"
              >
                {busy === "comment" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Post comment
              </Button>
            </div>
          </div>
        </section>

        <p className="mb-2 mt-1 flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground/60">
          <ClipboardCopy className="size-3" /> Shared via be10x — anyone with this link can review this task.
        </p>
      </div>
    </div>
  );
}

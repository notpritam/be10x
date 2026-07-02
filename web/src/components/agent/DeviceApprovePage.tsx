// ABOUTME: The `be10x login` approve screen (/connect?code=…). A signed-in user confirms a machine that ran
// ABOUTME: `be10x login`, minting it a token; the polling CLI then collects it. The browser half of device auth.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Laptop, Loader2, Plug, ShieldCheck, X } from "lucide-react";
import { ApiError, api, errorMessage } from "@/lib/api";
import type { User } from "@/lib/types";
import { Button } from "@/components/ui/button";

type Phase = "loading" | "ready" | "approving" | "approved" | "denied" | "invalid";

export function DeviceApprovePage({ code, user }: { code: string; user: User }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [label, setLabel] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    if (!code) {
      setPhase("invalid");
      setMessage("This link is missing its code. Re-run `be10x login` on your machine for a fresh one.");
      return;
    }
    api
      .devicePending(code)
      .then((info) => {
        if (!active) return;
        if (info.status !== "pending") {
          setPhase("invalid");
          setMessage(
            info.status === "expired"
              ? "This request expired. Re-run `be10x login` on your machine for a fresh code."
              : "This request was already handled. Re-run `be10x login` if you still need to connect.",
          );
          return;
        }
        setLabel(info.label);
        setPhase("ready");
      })
      .catch((err) => {
        if (!active) return;
        setPhase("invalid");
        setMessage(
          err instanceof ApiError && err.code === "NOT_FOUND"
            ? "We couldn't find that request. Re-run `be10x login` for a fresh code."
            : errorMessage(err),
        );
      });
    return () => {
      active = false;
    };
  }, [code]);

  const approve = useCallback(async () => {
    setPhase("approving");
    try {
      await api.deviceApprove(code);
      setPhase("approved");
    } catch (err) {
      setPhase("invalid");
      setMessage(errorMessage(err));
    }
  }, [code]);

  const deny = useCallback(async () => {
    try {
      await api.deviceDeny(code);
    } catch {
      /* best-effort — denying is a courtesy signal to the waiting CLI */
    }
    setPhase("denied");
  }, [code]);

  return (
    <div className="grid min-h-[100dvh] place-items-center bg-background px-5 py-10">
      <div className="w-full max-w-[440px] rounded-2xl border border-border bg-card p-7 shadow-pop">
        <div className="mb-5 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-primary/12 text-primary">
            <Plug className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[17px] font-bold tracking-tight text-foreground">Authorize this machine</h1>
            <p className="truncate text-[12.5px] text-muted-foreground">
              Signed in as {user.displayName || user.email}
            </p>
          </div>
        </div>

        {phase === "loading" && (
          <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking the request…
          </div>
        )}

        {phase === "ready" && (
          <>
            <p className="mb-4 text-[13px] leading-relaxed text-foreground/80">
              A machine that ran{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">be10x login</code> wants to
              connect to this board. Once you authorize it, it can run the agent on your tasks.
            </p>
            <div className="mb-5 space-y-2 rounded-xl border border-border bg-background px-4 py-3">
              <Row icon={<Laptop className="size-4" />} label="Machine" value={label || "unknown"} />
              <Row icon={<ShieldCheck className="size-4" />} label="Code" value={code} mono />
            </div>
            <p className="mb-4 text-[12px] leading-relaxed text-muted-foreground">
              Only authorize if you just started this on your own computer and the code matches what your
              terminal shows.
            </p>
            <div className="flex gap-2.5">
              <Button onClick={() => void approve()} className="h-10 flex-1 text-[13px]">
                <Check className="size-4" /> Authorize
              </Button>
              <Button variant="outline" onClick={() => void deny()} className="h-10 flex-1 text-[13px]">
                <X className="size-4" /> Not me
              </Button>
            </div>
          </>
        )}

        {phase === "approving" && (
          <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Authorizing…
          </div>
        )}

        {phase === "approved" && (
          <Result
            tone="ok"
            title="This machine is connected"
            body="Head back to your terminal — the CLI has its token. You can close this tab, then run be10x link in a repo and be10x connect."
          />
        )}

        {phase === "denied" && (
          <Result
            tone="warn"
            title="Request denied"
            body="Nothing was authorized. If this was you, re-run be10x login on your machine for a fresh code."
          />
        )}

        {phase === "invalid" && <Result tone="warn" title="Can't authorize this" body={message} />}
      </div>
    </div>
  );
}

function Row({ icon, label, value, mono }: { icon: ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="w-16 shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground ${mono ? "font-mono tracking-wider" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function Result({ tone, title, body }: { tone: "ok" | "warn"; title: string; body: string }) {
  const ok = tone === "ok";
  return (
    <div className="py-2">
      <div className="mb-3 flex items-center gap-2.5">
        <span
          className={`grid size-9 place-items-center rounded-xl ${ok ? "bg-primary/12 text-primary" : "bg-destructive/10 text-destructive"}`}
        >
          {ok ? <Check className="size-5" /> : <X className="size-5" />}
        </span>
        <h2 className="text-[15px] font-bold text-foreground">{title}</h2>
      </div>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

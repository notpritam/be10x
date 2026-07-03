// ABOUTME: Public landing page — what a logged-out visitor sees at the board root (and /join). Pitches the
// ABOUTME: product and shows the 2-minute teammate quickstart, then hands off to signup/signin. On-brand:
// warm terracotta accent, the ascending-columns motif, calm editorial layout — no neon, no AI gradient.
import { useState, type ReactNode } from "react";
import { ArrowRight, Check, Copy, Github, Plug, ListChecks, GitPullRequestArrow } from "lucide-react";
import { toast } from "sonner";
import { BrandTile, Wordmark } from "@/components/common/Brandmark";
import { Button } from "@/components/ui/button";

const REPO_URL = "https://github.com/notpritam/be10x";

function boardOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "https://your-board.example.com";
}

function CopyLine({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(cmd)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error("Couldn't copy."));
  };
  return (
    <div className="group flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-b-0">
      <span aria-hidden className="select-none font-mono text-[12px] text-primary/70">
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto scroll-thin whitespace-nowrap font-mono text-[12.5px] text-foreground">
        {cmd}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy command"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100"
      >
        {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

function Step({
  n,
  icon,
  title,
  children,
}: {
  n: string;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="relative flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-xl bg-primary/10 text-primary">{icon}</span>
        <span className="font-mono text-[12px] font-semibold text-muted-foreground/70">{n}</span>
      </div>
      <h3 className="text-[15px] font-bold tracking-tight text-foreground">{title}</h3>
      <p className="text-[13.5px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

export function LandingPage({
  onGetStarted,
  onSignIn,
}: {
  onGetStarted: () => void;
  onSignIn: () => void;
}) {
  const origin = boardOrigin();
  const commands = [
    "npm install -g github:notpritam/be10x",
    `be10x login ${origin}`,
    "cd ~/code/your-repo && be10x link",
    "be10x service install",
  ];

  return (
    <div className="relative min-h-[100dvh] overflow-x-hidden bg-background">
      {/* Warm ambience at the top — subtle, single hue. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px]"
        style={{
          background: "radial-gradient(52rem 32rem at 50% -12%, rgba(232,98,13,0.09), transparent 62%)",
        }}
      />

      <div className="relative mx-auto w-full max-w-[980px] px-6">
        {/* Nav */}
        <nav className="flex items-center justify-between py-5">
          <div className="flex items-center gap-2.5">
            <BrandTile className="size-8" />
            <Wordmark className="text-[16px]" />
          </div>
          <div className="flex items-center gap-1.5">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="be10x on GitHub"
            >
              <Github className="size-[18px]" />
            </a>
            <Button variant="ghost" onClick={onSignIn} className="h-9 px-3.5 text-[13px]">
              Sign in
            </Button>
          </div>
        </nav>

        {/* Hero */}
        <header className="pt-16 pb-14 text-center sm:pt-24 sm:pb-20">
          <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-1 text-[12px] font-medium text-muted-foreground shadow-sm">
            <span className="size-1.5 rounded-full bg-primary" />
            Human + agent task board
          </span>
          <h1 className="mx-auto mt-6 max-w-[16ch] text-balance text-[34px] font-extrabold leading-[1.06] tracking-[-0.02em] text-foreground sm:text-[52px]">
            Plan together. The agent runs on <span className="text-primary">your machine</span>.
          </h1>
          <p className="mx-auto mt-6 max-w-[54ch] text-pretty text-[15px] leading-relaxed text-muted-foreground sm:text-[16.5px]">
            be10x is a shared board for humans and coding agents. Hand a task to the agent and it works
            locally — your repo, your Claude login — streaming the plan and progress back for the team to
            review. The board keeps the state; the session is disposable.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button onClick={onGetStarted} className="h-11 w-full px-6 text-[14px] sm:w-auto">
              Get started
              <ArrowRight className="size-4" />
            </Button>
            <Button variant="outline" onClick={onSignIn} className="h-11 w-full px-6 text-[14px] sm:w-auto">
              Sign in
            </Button>
          </div>
          <p className="mt-4 text-[12.5px] text-muted-foreground/80">
            Free to run · your code never leaves your machine · needs Node 18+
          </p>
        </header>

        {/* How it works */}
        <section className="border-t border-border/60 py-16">
          <div className="grid gap-10 sm:grid-cols-3 sm:gap-8">
            <Step n="01" icon={<ListChecks className="size-[18px]" />} title="Create a task">
              Describe the work on the board — a bug, a feature, a chore. Add context or a plan, then hand it to
              the agent.
            </Step>
            <Step n="02" icon={<Plug className="size-[18px]" />} title="Your machine picks it up">
              On the teammate linked to that repo, Claude runs in a fresh git worktree — no shared server, no
              uploaded code, your own login.
            </Step>
            <Step n="03" icon={<GitPullRequestArrow className="size-[18px]" />} title="Review together">
              The plan, progress, diffs, and output stream back to the board. Comment, request changes, approve
              — like a PR for agent work.
            </Step>
          </div>
        </section>

        {/* Quickstart */}
        <section className="border-t border-border/60 py-16">
          <div className="grid items-center gap-10 sm:grid-cols-[0.9fr_1.1fr] sm:gap-12">
            <div>
              <h2 className="text-[24px] font-extrabold tracking-tight text-foreground sm:text-[28px]">
                Join a board in <span className="text-primary">2 minutes</span>
              </h2>
              <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
                Someone shared a board with you? Point your machine at it — the agent runs on your own repos,
                in the background, and starts on boot. See your status anytime with{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">be10x</code>.
              </p>
              <button
                type="button"
                onClick={onGetStarted}
                className="mt-6 inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded"
              >
                Create your account
                <ArrowRight className="size-4" />
              </button>
            </div>

            <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-pop">
              <div className="flex items-center gap-1.5 border-b border-border/60 px-4 py-2.5">
                <span className="size-2.5 rounded-full bg-destructive/40" />
                <span className="size-2.5 rounded-full bg-primary/40" />
                <span className="size-2.5 rounded-full bg-muted-foreground/30" />
                <span className="ml-2 font-mono text-[11.5px] text-muted-foreground/70">your terminal</span>
              </div>
              {commands.map((c) => (
                <CopyLine key={c} cmd={c} />
              ))}
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="flex flex-col items-center justify-between gap-4 border-t border-border/60 py-8 text-[12.5px] text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <BrandTile className="size-5" />
            <span>
              be10x — <span className="text-foreground/70">sessions disposable, state durable</span>
            </span>
          </div>
          <div className="flex items-center gap-5">
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">
              GitHub
            </a>
            <button type="button" onClick={onSignIn} className="transition-colors hover:text-foreground">
              Sign in
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

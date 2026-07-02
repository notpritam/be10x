// ABOUTME: Connect an agent (Claude Code) to be10x. Leads with the paste-free flow: install the CLI, run
// ABOUTME: `be10x login <board>` (approve in-browser), then `be10x link` + `be10x connect`. A manual-token
// ABOUTME: path (mint/copy a token + MCP config) stays under Advanced for CI / headless / same-machine use.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Copy, KeyRound, Loader2, Plug, ShieldCheck, Terminal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import type { AgentConfig, MintedToken, TokenInfo } from "@/lib/types";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// The board's own URL — when a member opens this hosted dashboard, the origin IS the board they link to.
function boardOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "https://your-board.example.com";
}

// The three commands a teammate runs — no token to copy, no flags. `be10x login` opens THIS board to approve.
const INSTALL_CMD = "npm install -g github:notpritam/be10x";
const LINK_CMD = "cd ~/code/your-repo\nbe10x link";
const CONNECT_CMD = "be10x connect";
const loginCmd = () => `be10x login ${boardOrigin()}`;

function buildMcpConfig(config: AgentConfig | null, token: string): string {
  const obj = {
    mcpServers: {
      be10x: {
        command: "node",
        args: [config?.mcpServerPath ?? "/path/to/git-for-agents/src/mcp/server.js"],
        env: { GFA_TOKEN: token, GFA_DB_PATH: config?.dbPath ?? "./gfa.db" },
      },
    },
  };
  return JSON.stringify(obj, null, 2);
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

function CommandRow({ cmd }: { cmd: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto scroll-thin whitespace-pre font-mono text-[12px] leading-relaxed text-foreground">
        {cmd}
      </code>
      <CopyButton text={cmd} />
    </div>
  );
}

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/12 text-[12px] font-bold text-primary">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-foreground">{title}</p>
        {hint && <p className="mb-2 mt-0.5 text-[11.5px] text-muted-foreground/80">{hint}</p>}
        {!hint && <div className="mb-2" />}
        {children}
      </div>
    </div>
  );
}

export function ConnectAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadTokens = useCallback(async () => {
    try {
      const { tokens } = await api.listTokens();
      setTokens(tokens);
    } catch {
      setTokens([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setName("");
    setMinted(null);
    setTokens(null);
    setConfig(null);
    void loadTokens();
    api
      .agentConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [open, loadTokens]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const { token } = await api.createToken(trimmed);
      setMinted(token);
      setName("");
      await loadTokens();
      toast.success("Token created. Copy it now.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    setRevokingId(id);
    try {
      await api.revokeToken(id);
      if (minted?.id === id) setMinted(null);
      await loadTokens();
      toast.success("Token revoked.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]">
        <DialogHeader className="border-b border-border/70 px-6 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <span className="grid size-7 place-items-center rounded-lg bg-primary/12 text-primary">
              <Plug className="size-4" />
            </span>
            Connect your machine
          </DialogTitle>
          <DialogDescription>
            Claude runs on your computer — your repos, your login. The board just coordinates. Three commands,
            no token to copy.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[72vh] flex-col overflow-y-auto scroll-thin px-6 py-5">
          {/* Primary path: install → login (approve in-browser) → link + connect. No token handling. */}
          <div className="flex flex-col gap-4">
            <Step n={1} title="Install the CLI" hint="One command — no clone, no build (needs Node 18+).">
              <CommandRow cmd={INSTALL_CMD} />
            </Step>
            <Step n={2} title="Sign in" hint="Opens this board in your browser — click Authorize. The token installs itself.">
              <CommandRow cmd={loginCmd()} />
            </Step>
            <Step n={3} title="Link a repo, then run the agent" hint="Point be10x link at each repo you want worked here. Leave connect running.">
              <div className="flex flex-col gap-2">
                <CommandRow cmd={LINK_CMD} />
                <CommandRow cmd={CONNECT_CMD} />
              </div>
            </Step>
          </div>

          <p className="mt-4 rounded-lg border border-border/60 bg-muted/40 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            Then create a task for one of those repos on the board — your machine picks it up, runs Claude
            locally, and streams the plan and progress back here for the team to review.
          </p>

          {/* Advanced: mint a token by hand (CI / headless / same-machine MCP config). */}
          <details className="mt-5 rounded-xl border border-border/60 bg-card/60 px-4 py-3">
            <summary className="cursor-pointer select-none text-[12.5px] font-semibold text-foreground/80">
              Advanced — mint a token by hand (CI, headless, or same-machine MCP)
            </summary>

            <div className="mt-3">
              <Label htmlFor="ca-name" className="mb-1.5 block text-[12px] text-foreground/80">
                Token name
              </Label>
              <div className="flex items-start gap-2">
                <Input
                  id="ca-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void create();
                    }
                  }}
                  placeholder="e.g. CI runner"
                  className="h-9 flex-1 bg-background text-[13px]"
                />
                <Button onClick={() => void create()} disabled={creating || !name.trim()} className="h-9 shrink-0 text-[13px]">
                  {creating ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      <KeyRound className="size-4" />
                      Create token
                    </>
                  )}
                </Button>
              </div>

              {minted && (
                <div className="mt-4 rounded-xl border border-primary/30 bg-primary/[0.04] p-4 soft-fade">
                  <div className="mb-2 flex items-center gap-2">
                    <ShieldCheck className="size-4 text-primary" />
                    <h3 className="text-[13px] font-bold text-foreground">Copy your token now — you won't see it again</h3>
                  </div>
                  <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">{minted.token}</code>
                    <CopyButton text={minted.token} label="Copy token" />
                  </div>

                  <div className="mb-1.5 flex items-center gap-2">
                    <Terminal className="size-4 text-primary" />
                    <p className="text-[12px] font-semibold text-foreground/80">Connect with the token (no browser)</p>
                  </div>
                  <CommandRow cmd={`be10x connect --board ${boardOrigin()} --token ${minted.token} --repos ~/code/your-repo`} />

                  <div className="mt-3.5 flex items-center justify-between">
                    <p className="text-[11.5px] text-muted-foreground/80">Same machine as the board? MCP config for Claude Code</p>
                    <CopyButton text={buildMcpConfig(config, minted.token)} label="Copy config" />
                  </div>
                  <pre className="mt-1.5 max-h-56 overflow-auto scroll-thin rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground/90">
                    {buildMcpConfig(config, minted.token)}
                  </pre>
                </div>
              )}
            </div>
          </details>

          {/* Existing tokens — device logins land here too, so this is where you revoke a machine's access. */}
          <div className="mt-6">
            <h3 className="mb-2.5 text-[12px] font-semibold text-muted-foreground/80">Your connected machines &amp; tokens</h3>
            {tokens === null ? (
              <div className="flex items-center gap-2 py-4 text-[12.5px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            ) : tokens.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border/70 px-3.5 py-6 text-center text-[12.5px] text-muted-foreground/70">
                No machines linked yet. Run the steps above to connect one.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {tokens.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-2.5">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <KeyRound className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-foreground">{t.name}</p>
                      <p className="truncate text-[11.5px] text-muted-foreground">
                        Created {relativeTime(t.createdAt)} ·{" "}
                        {t.lastUsedAt ? `last used ${relativeTime(t.lastUsedAt)}` : "never used"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void revoke(t.id)}
                      disabled={revokingId === t.id}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:opacity-50"
                    >
                      {revokingId === t.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
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

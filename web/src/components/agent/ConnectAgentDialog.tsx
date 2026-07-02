// ABOUTME: Connect an agent (Claude Code) to be10x over MCP. Mint a personal access token (POST /tokens),
// show the plaintext secret exactly ONCE with a copy button, and render a ready-to-paste MCP config JSON
// built from GET /api/agent-config + the new token. Also lists existing tokens with a Revoke action.
import { useCallback, useEffect, useState } from "react";
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

function buildMcpConfig(config: AgentConfig | null, token: string): string {
  const obj = {
    mcpServers: {
      be10x: {
        command: "node",
        args: [config?.mcpServerPath ?? "/path/to/git-for-agents/src/mcp/server.js"],
        env: {
          GFA_TOKEN: token,
          GFA_DB_PATH: config?.dbPath ?? "./gfa.db",
        },
      },
    },
  };
  return JSON.stringify(obj, null, 2);
}

// The board's own URL — when a member opens this hosted dashboard, the origin IS the board they link to.
function boardOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "https://your-board.example.com";
}

// Install the be10x CLI in one command — no repo clone, no build step (needs Node 18+).
const INSTALL_CMD = "npm install -g github:notpritam/be10x";

// The one command a member runs on THEIR machine to link it to this board and run the agent locally.
function buildConnectCommand(token: string): string {
  return `be10x connect --board ${boardOrigin()} --token ${token} --repos ~/code/your-repo`;
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
            Link your computer to this board. Claude runs on your machine, on your own repos and login — the
            board just coordinates the work. Nothing runs on the server.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[72vh] flex-col overflow-y-auto scroll-thin px-6 py-5">
          {/* Create a token */}
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
              placeholder="e.g. My laptop"
              className="h-9 flex-1 bg-background text-[13px]"
            />
            <Button
              onClick={() => void create()}
              disabled={creating || !name.trim()}
              className="h-9 shrink-0 text-[13px]"
            >
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
          <p className="mt-1.5 text-[11.5px] text-muted-foreground/80">
            Name it for where it runs. The secret is shown once, right after you create it.
          </p>

          {/* Freshly minted secret + config — shown ONCE */}
          {minted && (
            <div className="mt-4 rounded-xl border border-primary/30 bg-primary/[0.04] p-4 soft-fade">
              <div className="mb-2 flex items-center gap-2">
                <ShieldCheck className="size-4 text-primary" />
                <h3 className="text-[13px] font-bold text-foreground">
                  Copy your token now — you won't see it again
                </h3>
              </div>

              <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                  {minted.token}
                </code>
                <CopyButton text={minted.token} label="Copy token" />
              </div>

              {/* Primary path: run the agent on YOUR machine, linked to this board. */}
              <div className="mb-1.5 flex items-center gap-2">
                <Terminal className="size-4 text-primary" />
                <p className="text-[12px] font-semibold text-foreground/80">Run this on your machine</p>
              </div>
              <p className="mb-2 text-[11.5px] text-muted-foreground/80">
                Install the CLI once — no clone, no build (you'll use your own Claude Code login):
              </p>
              <div className="mb-2.5 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto scroll-thin whitespace-nowrap font-mono text-[12px] text-foreground">
                  {INSTALL_CMD}
                </code>
                <CopyButton text={INSTALL_CMD} label="Copy" />
              </div>
              <p className="mb-2 text-[11.5px] text-muted-foreground/80">
                Then link this machine — point <code className="font-mono text-[11px]">--repos</code> at the
                checkouts you want to work here:
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto scroll-thin whitespace-nowrap font-mono text-[12px] text-foreground">
                  {buildConnectCommand(minted.token)}
                </code>
                <CopyButton text={buildConnectCommand(minted.token)} label="Copy" />
              </div>
              <p className="mt-2 text-[11.5px] text-muted-foreground/80">
                Now create a task for one of those repos on the board — your machine picks it up, runs Claude
                locally, and streams the plan and progress back here for the team to review.
              </p>

              {/* Advanced: agent on the SAME machine as the board (local stdio MCP + shared db). */}
              <details className="mt-4 rounded-lg border border-border/60 bg-card/60 px-3 py-2">
                <summary className="cursor-pointer select-none text-[12px] font-medium text-muted-foreground">
                  Running Claude Code on the same machine as the board? Use this MCP config instead
                </summary>
                <div className="mt-2.5 flex items-center justify-between">
                  <p className="text-[11.5px] text-muted-foreground/80">MCP config for Claude Code</p>
                  <CopyButton text={buildMcpConfig(config, minted.token)} label="Copy config" />
                </div>
                <pre className="mt-1.5 max-h-56 overflow-auto scroll-thin rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground/90">
                  {buildMcpConfig(config, minted.token)}
                </pre>
                {!config && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground/80">
                    Couldn't reach the server for exact paths — replace the placeholder path and DB path with
                    yours.
                  </p>
                )}
              </details>
            </div>
          )}

          {/* Existing tokens */}
          <div className="mt-6">
            <h3 className="mb-2.5 text-[12px] font-semibold text-muted-foreground/80">Your tokens</h3>
            {tokens === null ? (
              <div className="flex items-center gap-2 py-4 text-[12.5px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading tokens…
              </div>
            ) : tokens.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border/70 px-3.5 py-6 text-center text-[12.5px] text-muted-foreground/70">
                No tokens yet. Create one above to connect an agent.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {tokens.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-2.5"
                  >
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
                      {revokingId === t.id ? (
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

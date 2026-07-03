// ABOUTME: The admin dashboard — a standalone page (route: /admin) gated by the GFA_ADMIN_TOKEN
// bearer secret, not the normal session/login. Shows platform-wide counts, a searchable user
// list, and per-user task/token-usage detail. See docs/superpowers/specs/2026-07-03-admin-dashboard-leaderboard-design.md.
import { useCallback, useEffect, useState } from "react";
import { Loader2, Search, ShieldAlert } from "lucide-react";
import {
  adminApi,
  AdminAuthError,
  clearAdminToken,
  compactNumber,
  formatCost,
  loadAdminToken,
  saveAdminToken,
  type AdminOverview,
  type AdminUserDetail,
  type AdminUserRow,
} from "@/lib/adminApi";
import { formatDate, initials } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card px-4 py-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{label}</p>
      <p className="mt-1 text-[22px] font-bold tabular-nums tracking-tight text-foreground">{value}</p>
    </div>
  );
}

function TokenGate({ onSubmit, error }: { onSubmit: (token: string) => void; error: string | null }) {
  const [value, setValue] = useState("");
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border/60 bg-card p-6 shadow-card">
        <div className="mb-4 flex items-center gap-2">
          <ShieldAlert className="size-5 text-primary" />
          <h1 className="text-[16px] font-bold">Admin dashboard</h1>
        </div>
        <p className="mb-4 text-[13px] text-muted-foreground">
          Enter the <code className="rounded bg-muted px-1 py-0.5 text-[12px]">GFA_ADMIN_TOKEN</code> configured on this
          deploy. It's kept only in this tab's session storage.
        </p>
        <Input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit(value)}
          placeholder="Admin token"
          className="h-10"
        />
        {error && (
          <p className="mt-2 text-[12.5px] font-medium text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button className="mt-3 w-full" onClick={() => onSubmit(value)} disabled={!value.trim()}>
          Continue
        </Button>
      </div>
    </div>
  );
}

export function AdminDashboard() {
  const [token, setToken] = useState<string | null>(() => loadAdminToken());
  const [gateError, setGateError] = useState<string | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  const load = useCallback(
    async (t: string, q = "") => {
      setLoading(true);
      setGateError(null);
      try {
        const [ov, list] = await Promise.all([adminApi.overview(t), adminApi.users(t, q)]);
        setOverview(ov);
        setUsers(list.users);
      } catch (err) {
        if (err instanceof AdminAuthError) {
          clearAdminToken();
          setToken(null);
          setGateError(err.message);
        } else {
          setGateError(err instanceof Error ? err.message : "Something went wrong.");
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (token) void load(token, query);
    // Reload on search only — token changes are handled by handleToken below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function handleToken(t: string) {
    saveAdminToken(t);
    setToken(t);
  }

  function handleSearch(q: string) {
    setQuery(q);
    if (token) void load(token, q);
  }

  async function openUser(id: string) {
    if (!token) return;
    setDetailLoading(id);
    try {
      setDetail(await adminApi.userDetail(token, id));
    } catch (err) {
      setGateError(err instanceof Error ? err.message : "Could not load that user.");
    } finally {
      setDetailLoading(null);
    }
  }

  if (!token) return <TokenGate onSubmit={handleToken} error={gateError} />;

  return (
    <div className="min-h-screen bg-background px-6 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-[20px] font-bold tracking-tight">Admin dashboard</h1>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearAdminToken();
              setToken(null);
            }}
          >
            Sign out
          </Button>
        </div>

        {overview && (
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Users" value={String(overview.userCount)} />
            <StatTile label="Active (7d)" value={String(overview.activeUsers)} />
            <StatTile label="Tasks" value={String(overview.taskCount)} />
            <StatTile label="Done" value={String(overview.doneCount)} />
            <StatTile label="Tokens (be10x)" value={compactNumber(overview.usage.inputTokens + overview.usage.outputTokens)} />
            <StatTile label="Cost (be10x)" value={formatCost(overview.usage.costUsd)} />
          </div>
        )}

        <div className="relative mb-3 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="h-9 pl-8 text-[13px]"
          />
          {loading && <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground/70" />}
        </div>

        {gateError && (
          <p className="mb-3 text-[12.5px] font-medium text-destructive" role="alert">
            {gateError}
          </p>
        )}

        <div className="overflow-hidden rounded-xl border border-border/60">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border/60 bg-muted/40 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Joined</th>
                <th className="px-3 py-2 text-right">Tasks</th>
                <th className="px-3 py-2 text-right">Done</th>
                <th className="px-3 py-2 text-right">Tokens</th>
                <th className="px-3 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {users?.map((u) => (
                <tr
                  key={u.id}
                  onClick={() => void openUser(u.id)}
                  className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-accent/40"
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="grid size-7 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white"
                        style={{ backgroundColor: `hsl(${(u.id.charCodeAt(0) * 47) % 360} 55% 45%)` }}
                      >
                        {initials(u.displayName || u.email)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">{u.displayName || u.email}</p>
                        <p className="truncate text-[11.5px] text-muted-foreground">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{formatDate(u.createdAt)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{u.taskCount}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{u.tasksDone}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{compactNumber(u.inputTokens + u.outputTokens)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatCost(u.costUsd)}</td>
                </tr>
              ))}
              {users && users.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    No users match "{query}".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={!!detail || !!detailLoading} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto scroll-thin sm:max-w-[560px]">
          {detailLoading && !detail ? (
            <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : detail ? (
            <>
              <DialogHeader>
                <DialogTitle>{detail.user.displayName || detail.user.email}</DialogTitle>
                <DialogDescription>
                  {detail.user.email} · joined {formatDate(detail.user.createdAt)}
                </DialogDescription>
              </DialogHeader>
              <div className="mb-4 grid grid-cols-3 gap-2">
                <StatTile label="Tasks" value={String(detail.tasks.length)} />
                <StatTile label="Done" value={String(detail.tasksDone)} />
                <StatTile label="Cost" value={formatCost(detail.totals.costUsd)} />
              </div>
              <ul className="flex flex-col gap-1.5">
                {detail.tasks.map((t) => (
                  <li key={t.id} className="rounded-lg border border-border/60 px-3 py-2 text-[12.5px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-foreground">
                        {t.humanId} · {t.title}
                      </span>
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                        {t.status}
                      </span>
                    </div>
                    <p className="mt-1 text-[11.5px] text-muted-foreground">
                      {compactNumber(t.inputTokens + t.outputTokens)} tokens · {formatCost(t.costUsd)}
                    </p>
                  </li>
                ))}
                {detail.tasks.length === 0 && <p className="py-4 text-center text-[12.5px] text-muted-foreground">No tasks yet.</p>}
              </ul>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

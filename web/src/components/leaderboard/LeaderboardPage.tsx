// ABOUTME: In-app leaderboard — tasks completed + token usage through be10x, ranked, with a scope
// dropdown (Everyone or one of your teams). Always-on platform data, not gated behind the opt-in
// CLI telemetry flag — see docs/superpowers/specs/2026-07-03-admin-dashboard-leaderboard-design.md.
import { useEffect, useState } from "react";
import { Loader2, Trophy } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { LeaderboardRow } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { UserAvatar } from "@/components/common/bits";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { compactNumber, formatCost } from "@/lib/adminApi";

function personName(row: LeaderboardRow): string {
  return row.displayName || row.email.split("@")[0];
}

export function LeaderboardPage() {
  const { user, teams } = useApp();
  const [scope, setScope] = useState("all");
  const [period, setPeriod] = useState<"all" | "month">("all");
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setRows(null);
    setError(null);
    api
      .leaderboard(scope, period)
      .then((r) => active && setRows(r.rows))
      .catch((err) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [scope, period]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin bg-background px-8 py-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Trophy className="size-5 text-primary" />
            <h1 className="text-[20px] font-bold tracking-tight">Leaderboard</h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
              <button
                type="button"
                onClick={() => setPeriod("month")}
                aria-pressed={period === "month"}
                className={
                  "h-7 rounded-md px-2.5 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 " +
                  (period === "month" ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground")
                }
              >
                This month
              </button>
              <button
                type="button"
                onClick={() => setPeriod("all")}
                aria-pressed={period === "all"}
                className={
                  "h-7 rounded-md px-2.5 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 " +
                  (period === "all" ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground")
                }
              >
                All time
              </button>
            </div>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="h-9 w-[180px] text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={`team:${t.id}`}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {error && (
          <p className="mb-3 text-[12.5px] font-medium text-destructive" role="alert">
            {error}
          </p>
        )}

        {!rows && !error ? (
          <div className="flex items-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows?.map((row, i) => (
              <li
                key={row.id}
                className={
                  "flex items-center gap-3 rounded-xl border px-3.5 py-3 " +
                  (row.id === user.id ? "border-primary/40 bg-primary/[0.04]" : "border-border/60 bg-card")
                }
              >
                <span className="w-6 shrink-0 text-center text-[13px] font-bold tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <UserAvatar name={personName(row)} seed={row.id} size={30} ring={false} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-foreground">
                    {personName(row)}
                    {row.id === user.id && <span className="ml-1.5 text-[11px] font-medium text-muted-foreground">· you</span>}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[13px] font-bold tabular-nums text-foreground">{row.tasksDone}</p>
                  <p className="text-[10.5px] text-muted-foreground">tasks done</p>
                </div>
                <div className="w-20 shrink-0 text-right">
                  <p className="text-[13px] font-semibold tabular-nums text-foreground">
                    {compactNumber(row.inputTokens + row.outputTokens)}
                  </p>
                  <p className="text-[10.5px] text-muted-foreground">tokens</p>
                </div>
                <div className="w-16 shrink-0 text-right">
                  <p className="text-[13px] font-semibold tabular-nums text-foreground">{formatCost(row.costUsd)}</p>
                  <p className="text-[10.5px] text-muted-foreground">cost</p>
                </div>
              </li>
            ))}
            {rows && rows.length === 0 && (
              <p className="py-10 text-center text-[13px] text-muted-foreground">No one here yet.</p>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

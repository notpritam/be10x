// ABOUTME: The Bugs dashboard — status + severity filter chips over a list of filed bug tickets; clicking a
// ABOUTME: row opens its detail. Reads the M1 bug API (api.listBugs); mirrors LeaderboardPage's fetch+render.
import { useEffect, useMemo, useState } from "react";
import { Bug as BugIcon, Loader2, UserRound } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { Bug, BugSeverity, BugStatus } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { cn, relativeTime } from "@/lib/utils";
import { UserAvatar } from "@/components/common/bits";
import { BugDetail } from "./BugDetail";
import {
  BUG_SEVERITY_ORDER,
  BUG_STATUS_META,
  BUG_STATUS_ORDER,
  BugSeverityPill,
  BugStatusBadge,
  BugTagChips,
} from "./bug-bits";

type StatusFilter = BugStatus | "all";
type SeverityFilter = BugSeverity | "all";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  ...BUG_STATUS_ORDER.map((s) => ({ value: s as StatusFilter, label: BUG_STATUS_META[s].label })),
];

const SEVERITY_OPTIONS: { value: SeverityFilter; label: string }[] = [
  { value: "all", label: "All" },
  ...BUG_SEVERITY_ORDER.map((s) => ({
    value: s as SeverityFilter,
    label: s.charAt(0).toUpperCase() + s.slice(1),
  })),
];

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function BugsPage() {
  const { user, teams, projects } = useApp();
  const [selectedBugId, setSelectedBugId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [bugs, setBugs] = useState<Bug[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The list route narrows by status server-side; severity/tag/team/project are filtered client-side below.
  useEffect(() => {
    let active = true;
    setBugs(null);
    setError(null);
    api
      .listBugs({ status: statusFilter === "all" ? undefined : statusFilter })
      .then((r) => active && setBugs(r.bugs))
      .catch((err) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [statusFilter]);

  // Filter options are derived from what's actually present in the loaded bugs, so a control only appears
  // once there's something to narrow by (no empty Team/Project/Tag rows on a fresh board).
  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    for (const b of bugs ?? []) for (const t of b.tags) set.add(t);
    return [...set].sort();
  }, [bugs]);
  const teamOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const b of bugs ?? []) if (b.teamId) ids.add(b.teamId);
    return [...ids].map((id) => ({ value: id, label: teams.find((t) => t.id === id)?.name ?? "Team" }));
  }, [bugs, teams]);
  const projectOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const b of bugs ?? []) if (b.projectId) ids.add(b.projectId);
    return [...ids].map((id) => ({ value: id, label: projects.find((p) => p.id === id)?.name ?? "Project" }));
  }, [bugs, projects]);

  const visible = useMemo(
    () =>
      (bugs ?? []).filter(
        (b) =>
          (severityFilter === "all" || b.severity === severityFilter) &&
          (tagFilter === "all" || b.tags.includes(tagFilter)) &&
          (teamFilter === "all" || b.teamId === teamFilter) &&
          (projectFilter === "all" || b.projectId === projectFilter),
      ),
    [bugs, severityFilter, tagFilter, teamFilter, projectFilter],
  );

  if (selectedBugId) {
    return <BugDetail bugId={selectedBugId} onBack={() => setSelectedBugId(null)} />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin bg-background px-8 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-5 flex items-center gap-2">
          <BugIcon className="size-5 text-primary" />
          <h1 className="text-[20px] font-bold tracking-tight">Bugs</h1>
        </div>

        <div className="mb-5 space-y-2">
          <FilterChips label="Status" value={statusFilter} options={STATUS_OPTIONS} onChange={setStatusFilter} />
          <FilterChips
            label="Severity"
            value={severityFilter}
            options={SEVERITY_OPTIONS}
            onChange={setSeverityFilter}
          />
          {teamOptions.length > 0 && (
            <FilterChips
              label="Team"
              value={teamFilter}
              options={[{ value: "all", label: "All" }, ...teamOptions]}
              onChange={setTeamFilter}
            />
          )}
          {projectOptions.length > 0 && (
            <FilterChips
              label="Project"
              value={projectFilter}
              options={[{ value: "all", label: "All" }, ...projectOptions]}
              onChange={setProjectFilter}
            />
          )}
          {tagOptions.length > 0 && (
            <FilterChips
              label="Tag"
              value={tagFilter}
              options={[{ value: "all", label: "All" }, ...tagOptions.map((t) => ({ value: t, label: t }))]}
              onChange={setTagFilter}
            />
          )}
        </div>

        {error && (
          <p className="mb-3 text-[12.5px] font-medium text-destructive" role="alert">
            {error}
          </p>
        )}

        {!bugs && !error ? (
          <div className="flex items-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {visible.map((bug) => (
              <li key={bug.id}>
                <button
                  type="button"
                  onClick={() => setSelectedBugId(bug.id)}
                  className="flex w-full items-center gap-3 rounded-xl border border-border/60 bg-card px-3.5 py-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <span className="w-14 shrink-0 font-mono text-[11px] font-medium tracking-wide text-muted-foreground">
                    {bug.humanId}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-foreground">{bug.title}</p>
                    <p className="truncate text-[11.5px] text-muted-foreground">{hostOf(bug.pageUrl)}</p>
                    {bug.tags.length > 0 && <BugTagChips tags={bug.tags} className="mt-1" />}
                  </div>
                  <BugSeverityPill severity={bug.severity} />
                  <BugStatusBadge status={bug.status} />
                  <span className="hidden w-16 shrink-0 items-center justify-end sm:flex">
                    {bug.reporterId === user.id ? (
                      <span className="flex items-center gap-1.5">
                        <UserAvatar name={user.displayName} seed={user.id} size={24} ring={false} />
                        <span className="text-[11px] font-medium text-muted-foreground">You</span>
                      </span>
                    ) : (
                      <span
                        className="grid size-6 place-items-center rounded-full bg-muted text-muted-foreground"
                        title={`Reporter ${bug.reporterId.slice(0, 8)}`}
                      >
                        <UserRound className="size-3.5" />
                      </span>
                    )}
                  </span>
                  <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground">
                    {relativeTime(bug.createdAt)}
                  </span>
                </button>
              </li>
            ))}
            {bugs && visible.length === 0 && (
              <p className="py-10 text-center text-[13px] text-muted-foreground">
                {bugs.length === 0 ? "No bugs reported yet." : "No bugs match these filters."}
              </p>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilterChips<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 w-14 shrink-0 text-[11.5px] font-medium text-muted-foreground/70">{label}</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "rounded-full px-2.5 py-1 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
            value === o.value
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ABOUTME: The Bugs dashboard — status + severity filter chips over a list of filed bug tickets; clicking a
// ABOUTME: row opens its detail. Reads the M1 bug API (api.listBugs); mirrors LeaderboardPage's fetch+render.
import { useEffect, useMemo, useRef, useState } from "react";
import { Bug as BugIcon, Loader2, Search, UserRound } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import type { Bug, BugSeverity, BugStatus } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { cn, relativeTime } from "@/lib/utils";
import { UserAvatar } from "@/components/common/bits";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BugDetail } from "./BugDetail";
import {
  BUG_SEVERITY_ORDER,
  BUG_STATUS_META,
  BUG_STATUS_ORDER,
  BugSeverityPill,
  BugTagChips,
} from "./bug-bits";

/** True when a keystroke lands in a text field / select / editable — so global list shortcuts don't hijack it. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

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
  // The open bug persists across refreshes (sessionStorage), matching AppShell's panel restore — so a
  // reload lands you back on the exact bug, not the board.
  const [selectedBugId, setSelectedBugId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem("be10x.selectedBug");
    } catch {
      return null;
    }
  });
  const selectBug = (id: string | null) => {
    setSelectedBugId(id);
    try {
      if (id) sessionStorage.setItem("be10x.selectedBug", id);
      else sessionStorage.removeItem("be10x.selectedBug");
    } catch {
      /* ignore */
    }
  };
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [mineAssigned, setMineAssigned] = useState(false);
  const [mineReported, setMineReported] = useState(false);
  const [bugs, setBugs] = useState<Bug[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Keyboard navigation: the highlighted row (−1 = none). ↑/↓ move it, ↵ opens it, "/" focuses search.
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const activeRowRef = useRef<HTMLLIElement | null>(null);

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

  const query = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      (bugs ?? []).filter(
        (b) =>
          (severityFilter === "all" || b.severity === severityFilter) &&
          (tagFilter === "all" || b.tags.includes(tagFilter)) &&
          (teamFilter === "all" || b.teamId === teamFilter) &&
          (projectFilter === "all" || b.projectId === projectFilter) &&
          (!mineAssigned || b.assigneeId === user.id) &&
          (!mineReported || b.reporterId === user.id) &&
          (query === "" ||
            b.title.toLowerCase().includes(query) ||
            b.humanId.toLowerCase().includes(query) ||
            b.pageUrl.toLowerCase().includes(query) ||
            b.tags.some((t) => t.toLowerCase().includes(query))),
      ),
    [bugs, severityFilter, tagFilter, teamFilter, projectFilter, mineAssigned, mineReported, user.id, query],
  );

  // Board health: counts per status across the loaded set — a glance strip above the list.
  const statusCounts = useMemo(() => {
    const counts = new Map<BugStatus, number>();
    for (const b of bugs ?? []) counts.set(b.status, (counts.get(b.status) ?? 0) + 1);
    return BUG_STATUS_ORDER.map((s) => ({ status: s, count: counts.get(s) ?? 0 })).filter((x) => x.count > 0);
  }, [bugs]);

  // Keep the highlight in range as the filtered set changes, and scroll it into view as it moves.
  useEffect(() => {
    setActiveIndex((i) => (i >= visible.length ? visible.length - 1 : i));
  }, [visible.length]);
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Global list shortcuts (only while the list — not a bug detail — is showing).
  useEffect(() => {
    if (selectedBugId) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      // Navigate only from the search box or an unfocused page — never steal keys from the inline status
      // Select (a button) or any other control.
      const allowNav = t === searchRef.current || t === document.body || t === document.documentElement;
      if (e.key === "/" && !isTypingTarget(t)) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "ArrowDown" && allowNav) {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, visible.length - 1));
      } else if (e.key === "ArrowUp" && allowNav) {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && allowNav && activeIndex >= 0 && visible[activeIndex]) {
        e.preventDefault();
        selectBug(visible[activeIndex].id);
      } else if (e.key === "Escape" && t === searchRef.current) {
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // selectBug is stable enough; re-bind on the data the handler reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBugId, visible, activeIndex]);

  // Optimistically change a bug's status from the list. On success, when a specific status filter is active,
  // refetch so a now-non-matching bug drops out; on failure, toast + resync.
  const refetch = () =>
    api
      .listBugs({ status: statusFilter === "all" ? undefined : statusFilter })
      .then((r) => setBugs(r.bugs))
      .catch(() => {});
  const updateStatus = (id: string, status: BugStatus) => {
    setBugs((prev) => (prev ? prev.map((b) => (b.id === id ? { ...b, status } : b)) : prev));
    api
      .updateBugStatus(id, status)
      .then(() => {
        toast.success(`Marked ${BUG_STATUS_META[status].label.toLowerCase()}.`);
        if (statusFilter !== "all") void refetch();
      })
      .catch((err) => {
        toast.error(errorMessage(err));
        void refetch();
      });
  };

  if (selectedBugId) {
    return <BugDetail bugId={selectedBugId} onBack={() => selectBug(null)} />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin bg-background px-8 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <BugIcon className="size-5 text-primary" />
          <h1 className="text-[20px] font-bold tracking-tight">Bugs</h1>
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setActiveIndex(-1);
              }}
              placeholder="Search bugs…"
              aria-label="Search bugs"
              className="h-8 w-full rounded-lg border border-border/60 bg-card pl-8 pr-8 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border/60 bg-muted px-1 font-mono text-[10px] text-muted-foreground sm:block">
              /
            </kbd>
          </div>
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
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 w-14 shrink-0 text-[11.5px] font-medium text-muted-foreground/70">Mine</span>
            <MineToggle label="Assigned to me" active={mineAssigned} onToggle={() => setMineAssigned((v) => !v)} />
            <MineToggle label="Reported by me" active={mineReported} onToggle={() => setMineReported((v) => !v)} />
          </div>
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
          <>
            {bugs && bugs.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="text-[11.5px] text-muted-foreground/80">
                  {visible.length === bugs.length
                    ? `${bugs.length} ${bugs.length === 1 ? "bug" : "bugs"}`
                    : `${visible.length} of ${bugs.length}`}
                </p>
                {statusCounts.length > 1 && (
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    {statusCounts.map(({ status, count }) => (
                      <button
                        key={status}
                        type="button"
                        onClick={() => setStatusFilter(statusFilter === status ? "all" : status)}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                        title={`Filter by ${BUG_STATUS_META[status].label}`}
                      >
                        <span className="size-2 rounded-full" style={{ background: BUG_STATUS_META[status].color }} />
                        {BUG_STATUS_META[status].label} <span className="font-medium text-foreground">{count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <ul className="flex flex-col gap-1.5">
              {visible.map((bug, i) => (
                <li
                  key={bug.id}
                  ref={i === activeIndex ? activeRowRef : null}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 transition-colors",
                    i === activeIndex
                      ? "border-primary/60 ring-1 ring-primary/30"
                      : "border-border/60 hover:border-primary/40 hover:bg-accent/40",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectBug(bug.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
                  <InlineStatus status={bug.status} onChange={(s) => updateStatus(bug.id, s)} />
                </li>
              ))}
              {bugs && visible.length === 0 && (
                <p className="py-10 text-center text-[13px] text-muted-foreground">
                  {bugs.length === 0
                    ? "No bugs reported yet."
                    : query
                      ? "No bugs match your search."
                      : "No bugs match these filters."}
                </p>
              )}
            </ul>
          </>
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

/** Compact inline status control on a list row — change a bug's status without opening it (a colored-dot
 *  trigger + the design-system Select). Lives outside the row's open-button, so it never triggers navigation. */
function InlineStatus({ status, onChange }: { status: BugStatus; onChange: (s: BugStatus) => void }) {
  return (
    <Select value={status} onValueChange={(v) => onChange(v as BugStatus)}>
      <SelectTrigger aria-label="Change status" className="h-7 w-auto shrink-0 gap-1.5 border-border/60 px-2 text-[11.5px]">
        <span className="size-2 shrink-0 rounded-full" style={{ background: BUG_STATUS_META[status].color }} />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {BUG_STATUS_ORDER.map((s) => (
          <SelectItem key={s} value={s} className="text-[12.5px]">
            {BUG_STATUS_META[s].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A "Mine" quick-filter toggle chip (Assigned to me / Reported by me). */
function MineToggle({ label, active, onToggle }: { label: string; active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={cn(
        "rounded-full px-2.5 py-1 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

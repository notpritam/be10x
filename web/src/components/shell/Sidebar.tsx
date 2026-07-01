// ABOUTME: Collapsible left rail — brand mark (click to re-expand), Views (with counts), Teams
// (from /api/teams + a New team popover), and a user footer with logout. Collapse is reversible.
import { useState, type ReactNode } from "react";
import {
  ChevronsLeft,
  GitPullRequestArrow,
  Inbox,
  LogOut,
  MessageCircleQuestion,
  Plug,
  Plus,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { useApp, viewKey, type View } from "@/state/app-store";
import { errorMessage } from "@/lib/api";
import { cn, initials } from "@/lib/utils";
import { BrandTile, Wordmark } from "@/components/common/Brandmark";
import { UserAvatar } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function Sidebar({
  collapsed,
  onToggleCollapse,
  onConnectAgent,
  onNewTask,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onConnectAgent: () => void;
  onNewTask: () => void;
}) {
  const { user, teams, view, setView, counts, logout } = useApp();
  const activeKey = viewKey(view);

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
        collapsed ? "w-[64px]" : "w-[250px]",
      )}
    >
      {/* Brand / collapse header */}
      <div className="flex h-14 items-center gap-2 px-3">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <BrandTile />
          {!collapsed && <Wordmark />}
        </button>
        {!collapsed && (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label="Collapse sidebar"
          >
            <ChevronsLeft className="size-4" />
          </button>
        )}
      </div>

      {/* Primary action */}
      <div className="px-2.5 pb-1">
        <button
          type="button"
          onClick={onNewTask}
          title="New task"
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-lg bg-primary px-2.5 text-[13px] font-semibold text-primary-foreground shadow-card transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            collapsed && "justify-center px-0",
          )}
        >
          <Plus className="size-[17px]" />
          {!collapsed && "New task"}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto scroll-thin px-2.5 py-2">
        <Section label="Views" collapsed={collapsed} />
        <NavRow
          collapsed={collapsed}
          icon={<Inbox className="size-[17px]" />}
          label="All tasks"
          count={counts.all}
          active={activeKey === "all"}
          onClick={() => setView({ kind: "all" })}
        />
        <NavRow
          collapsed={collapsed}
          icon={<UserRound className="size-[17px]" />}
          label="Personal"
          count={counts.personal}
          active={activeKey === "personal"}
          onClick={() => setView({ kind: "personal" })}
        />
        <NavRow
          collapsed={collapsed}
          icon={<MessageCircleQuestion className="size-[17px]" />}
          label="Needs you"
          count={counts.needsInput}
          accent={counts.needsInput > 0}
          active={activeKey === "needs_input"}
          onClick={() => setView({ kind: "needs_input" })}
        />
        <NavRow
          collapsed={collapsed}
          icon={<GitPullRequestArrow className="size-[17px]" />}
          label="Review queue"
          count={counts.reviewQueue}
          accent={counts.reviewQueue > 0}
          active={activeKey === "review_queue"}
          onClick={() => setView({ kind: "review_queue" })}
        />

        <div className="mt-4 flex items-center justify-between pr-1">
          <Section label="Teams" collapsed={collapsed} inline />
          {!collapsed && <NewTeamButton onCreated={(v) => setView(v)} />}
        </div>

        {teams.length === 0 && !collapsed && (
          <p className="px-2 py-1.5 text-[12px] leading-relaxed text-muted-foreground/80">
            No teams yet. Create one to group shared work.
          </p>
        )}
        {teams.map((team) => (
          <NavRow
            key={team.id}
            collapsed={collapsed}
            icon={
              <span className="grid size-[17px] place-items-center rounded-[5px] bg-muted text-[9px] font-bold text-muted-foreground">
                {initials(team.name)}
              </span>
            }
            label={team.name}
            count={counts.team[team.id] ?? 0}
            active={activeKey === `team:${team.id}`}
            onClick={() => setView({ kind: "team", teamId: team.id, name: team.name })}
          />
        ))}
        {collapsed && (
          <NewTeamButton collapsed onCreated={(v) => setView(v)} />
        )}
      </nav>

      {/* User footer */}
      <div className="border-t border-sidebar-border p-2.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50",
                collapsed && "justify-center px-0",
              )}
            >
              <UserAvatar name={user.displayName} seed={user.id} size={28} ring={false} />
              {!collapsed && (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-foreground">
                    {user.displayName}
                  </span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {user.email}
                  </span>
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuLabel className="truncate text-muted-foreground">
              {user.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onConnectAgent}>
              <Plug className="size-4" />
              Connect an agent
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => void logout()}
              className="text-destructive focus:text-destructive"
            >
              <LogOut className="size-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}

function Section({
  label,
  collapsed,
  inline,
}: {
  label: string;
  collapsed: boolean;
  inline?: boolean;
}) {
  if (collapsed) return inline ? null : <div className="h-2" />;
  return (
    <p
      className={cn(
        "px-2 text-[11px] font-semibold tracking-wide text-muted-foreground/70",
        inline ? "py-1" : "mb-1 mt-1 pt-1",
      )}
    >
      {label}
    </p>
  );
}

function NavRow({
  collapsed,
  icon,
  label,
  count,
  active,
  accent,
  onClick,
}: {
  collapsed: boolean;
  icon: ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  accent?: boolean;
  onClick: () => void;
}) {
  const row = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
        collapsed && "justify-center px-0",
        active
          ? "bg-sidebar-accent text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
      )}
      <span className={cn("shrink-0", active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
        {icon}
      </span>
      {!collapsed && (
        <>
          <span className="flex-1 truncate text-left">{label}</span>
          {count !== undefined && count > 0 && (
            <span
              className={cn(
                "min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] font-semibold tabular-nums",
                accent
                  ? "bg-primary/12 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {count}
            </span>
          )}
        </>
      )}
    </button>
  );

  if (!collapsed) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {count ? ` · ${count}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

function NewTeamButton({
  collapsed,
  onCreated,
}: {
  collapsed?: boolean;
  onCreated: (view: View) => void;
}) {
  const { createTeam } = useApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const team = await createTeam(trimmed);
      toast.success(`Team "${team.name}" created.`);
      onCreated({ kind: "team", teamId: team.id, name: team.name });
      setName("");
      setOpen(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {collapsed ? (
          <button
            type="button"
            className="mx-auto mt-1 grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label="New team"
          >
            <Plus className="size-[17px]" />
          </button>
        ) : (
          <button
            type="button"
            className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label="New team"
          >
            <Plus className="size-4" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-64 p-3">
        <p className="mb-2 text-[13px] font-semibold">New team</p>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          placeholder="e.g. Platform"
          className="h-9 text-[13px]"
        />
        <div className="mt-2.5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void create()} disabled={busy || !name.trim()}>
            Create
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

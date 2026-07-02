// ABOUTME: Manage a team — members (with role change + remove), and an "Add people" flow that searches
// the platform (typeahead by name/email), offers recent collaborators as one-click chips, and falls back
// to add-by-email. Owner-only Delete team with a confirm step. Email invites to non-users are V2.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock, Loader2, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Member, TeamRole, UserLite } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { cn } from "@/lib/utils";
import { UserAvatar } from "@/components/common/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ROLE_LABEL: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

// Roles you can assign when adding or changing someone (ownership isn't handed out here).
const ASSIGNABLE: TeamRole[] = ["admin", "member", "viewer"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function personName(u: { displayName?: string | null; email?: string | null }): string {
  if (u.displayName) return u.displayName;
  if (u.email) return u.email.split("@")[0];
  return "Unknown";
}

function RoleBadge({ role }: { role: TeamRole }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        role === "owner" ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {ROLE_LABEL[role] ?? role}
    </span>
  );
}

export function ManageTeamDialog({
  open,
  onOpenChange,
  team,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: { id: string; name: string } | null;
}) {
  const { user, setView, reloadTeams, reloadTasks } = useApp();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [recent, setRecent] = useState<UserLite[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Add-people state.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserLite[]>([]);
  const [searching, setSearching] = useState(false);
  const [addRole, setAddRole] = useState<TeamRole>("member");
  const [addingId, setAddingId] = useState<string | null>(null); // "email" while adding by email
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const teamId = team?.id ?? null;
  const searchBox = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    if (!teamId) return;
    setLoadError(null);
    try {
      const [membersRes, recentRes] = await Promise.all([
        api.listMembers(teamId),
        api.recentPeople(teamId).catch(() => ({ users: [] as UserLite[] })),
      ]);
      setMembers(membersRes.members);
      setRecent(recentRes.users);
    } catch (err) {
      setLoadError(errorMessage(err));
      setMembers([]);
    }
  }, [teamId]);

  // Fetch on open; reset transient UI each time it opens.
  useEffect(() => {
    if (open && teamId) {
      setQuery("");
      setResults([]);
      setInviteError(null);
      setAddRole("member");
      setConfirmingDelete(false);
      setMembers(null);
      void reload();
    }
  }, [open, teamId, reload]);

  // Debounced platform search (by name or email), excluding people already on the team.
  useEffect(() => {
    const term = query.trim();
    setInviteError(null);
    if (!term) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { users } = await api.searchUsers(term, teamId ?? undefined);
        if (!cancelled) setResults(users);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, teamId]);

  const myRole = members?.find((m) => m.userId === user.id)?.role;
  const isOwner = myRole === "owner";
  const canManage = isOwner || myRole === "admin";
  const trimmed = query.trim();
  const showEmailFallback =
    canManage && !searching && results.length === 0 && EMAIL_RE.test(trimmed) && addingId === null;

  async function addUser(u: UserLite) {
    if (!teamId || addingId) return;
    setAddingId(u.id);
    setInviteError(null);
    try {
      await api.addMemberById(teamId, u.id, addRole);
      toast.success(`${personName(u)} added to ${team?.name ?? "the team"}.`);
      setQuery("");
      setResults([]);
      searchBox.current?.focus();
      await reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === "ALREADY_MEMBER") toast.error("They're already on this team.");
      else toast.error(errorMessage(err));
    } finally {
      setAddingId(null);
    }
  }

  async function addByEmail() {
    if (!teamId || addingId || !EMAIL_RE.test(trimmed)) return;
    setAddingId("email");
    setInviteError(null);
    try {
      await api.addMember(teamId, trimmed, addRole);
      toast.success(`${trimmed} added to ${team?.name ?? "the team"}.`);
      setQuery("");
      setResults([]);
      await reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === "USER_NOT_FOUND") {
        setInviteError("No account with that email yet. Email invites are coming soon — for now, ask them to sign up and they'll show up in search.");
      } else if (err instanceof ApiError && err.code === "ALREADY_MEMBER") {
        setInviteError("They're already on this team.");
      } else {
        setInviteError(errorMessage(err));
      }
    } finally {
      setAddingId(null);
    }
  }

  async function changeRole(m: Member, role: TeamRole) {
    if (!teamId || role === m.role) return;
    setRowBusy(m.userId);
    try {
      await api.setMemberRole(teamId, m.userId, role);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRowBusy(null);
    }
  }

  async function removeUser(m: Member) {
    if (!teamId) return;
    setRowBusy(m.userId);
    try {
      await api.removeMember(teamId, m.userId);
      toast.success(`${personName(m)} removed.`);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRowBusy(null);
    }
  }

  async function removeTeam() {
    if (!teamId || deleting) return;
    setDeleting(true);
    try {
      await api.deleteTeam(teamId);
      toast.success(`Team "${team?.name ?? ""}" deleted.`);
      onOpenChange(false);
      setView({ kind: "all" });
      await Promise.all([reloadTeams(), reloadTasks()]);
    } catch (err) {
      toast.error(errorMessage(err));
      setDeleting(false);
    }
  }

  const memberIds = new Set(members?.map((m) => m.userId));
  const recentToShow = recent.filter((r) => !memberIds.has(r.id)).slice(0, 6);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-[540px]">
        <DialogHeader className="border-b border-border/70 px-6 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <span className="grid size-7 place-items-center rounded-lg bg-primary/12 text-primary">
              <Users className="size-4" />
            </span>
            Manage team
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{team?.name}</span> · members and access
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[74vh] flex-col overflow-y-auto scroll-thin px-6 py-5">
          {/* Add people — search the platform + recent quick-add. */}
          {canManage && (
            <div className="mb-6">
              <h3 className="mb-2 text-[12px] font-semibold text-muted-foreground/80">Add people</h3>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
                  <Input
                    ref={searchBox}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name or email…"
                    className="h-9 bg-background pl-8 text-[13px]"
                  />
                  {searching && (
                    <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground/70" />
                  )}
                </div>
                <Select value={addRole} onValueChange={(v) => setAddRole(v as TeamRole)}>
                  <SelectTrigger className="h-9 w-[104px] shrink-0 text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSIGNABLE.map((r) => (
                      <SelectItem key={r} value={r} className="text-[12.5px]">
                        {ROLE_LABEL[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Search results */}
              {trimmed && (results.length > 0 || (!searching && addingId === null)) && (
                <ul className="mt-2 flex flex-col gap-1">
                  {results.map((u) => (
                    <li key={u.id} className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card px-3 py-2">
                      <UserAvatar name={personName(u)} seed={u.id} size={28} ring={false} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12.5px] font-semibold text-foreground">{personName(u)}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{u.email}</p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => void addUser(u)}
                        disabled={addingId !== null}
                        className="h-7 shrink-0 gap-1 px-2.5 text-[12px]"
                      >
                        {addingId === u.id ? <Loader2 className="size-3.5 animate-spin" /> : <UserPlus className="size-3.5" />}
                        Add
                      </Button>
                    </li>
                  ))}
                  {results.length === 0 && !searching && !showEmailFallback && (
                    <li className="rounded-xl border border-dashed border-border/60 px-3 py-2.5 text-[12px] text-muted-foreground">
                      No one on the platform matches "{trimmed}".
                    </li>
                  )}
                  {showEmailFallback && (
                    <li className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card px-3 py-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">@</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12.5px] font-medium text-foreground">Add by email</p>
                        <p className="truncate text-[11px] text-muted-foreground">{trimmed}</p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => void addByEmail()}
                        disabled={addingId !== null}
                        className="h-7 shrink-0 gap-1 px-2.5 text-[12px]"
                      >
                        {addingId === "email" ? <Loader2 className="size-3.5 animate-spin" /> : <UserPlus className="size-3.5" />}
                        Add
                      </Button>
                    </li>
                  )}
                </ul>
              )}

              {inviteError && (
                <p className="mt-2 text-[12px] font-medium text-destructive" role="alert">
                  {inviteError}
                </p>
              )}

              {/* Recent collaborators (when not searching) */}
              {!trimmed && recentToShow.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/70">
                    <Clock className="size-3.5" /> Recent people
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {recentToShow.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => void addUser(u)}
                        disabled={addingId !== null}
                        title={`Add ${u.email} as ${ROLE_LABEL[addRole]}`}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card py-1 pl-1 pr-2.5 text-[12px] font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/[0.04] disabled:opacity-60"
                      >
                        <UserAvatar name={personName(u)} seed={u.id} size={20} ring={false} />
                        {personName(u)}
                        {addingId === u.id ? <Loader2 className="size-3 animate-spin" /> : <UserPlus className="size-3 text-muted-foreground" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Members */}
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-[12px] font-semibold text-muted-foreground/80">Members</h3>
              {members && (
                <span className="text-[11.5px] tabular-nums text-muted-foreground/70">
                  {members.length} {members.length === 1 ? "person" : "people"}
                </span>
              )}
            </div>

            {members === null && !loadError ? (
              <div className="flex items-center gap-2 py-6 text-[12.5px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading members…
              </div>
            ) : loadError ? (
              <div className="rounded-xl border border-border/70 bg-muted/40 px-3.5 py-3 text-[12.5px] text-muted-foreground">
                Couldn't load members. {loadError}
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {members!.map((m) => {
                  const name = personName(m);
                  const isSelf = m.userId === user.id;
                  const busy = rowBusy === m.userId;
                  // Owners/admins manage others; owner rows and yourself aren't editable here.
                  const editable = canManage && !isSelf && m.role !== "owner";
                  return (
                    <li
                      key={m.userId}
                      className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-2.5"
                    >
                      <UserAvatar name={name} seed={m.userId} size={30} ring={false} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold text-foreground">
                          {name}
                          {isSelf && <span className="ml-1.5 text-[11px] font-medium text-muted-foreground">· you</span>}
                        </p>
                        {m.email && <p className="truncate text-[11.5px] text-muted-foreground">{m.email}</p>}
                      </div>

                      {editable ? (
                        <>
                          <Select value={m.role} onValueChange={(v) => void changeRole(m, v as TeamRole)} disabled={busy}>
                            <SelectTrigger className="h-8 w-[100px] shrink-0 text-[12px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ASSIGNABLE.map((r) => (
                                <SelectItem key={r} value={r} className="text-[12.5px]">
                                  {ROLE_LABEL[r]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <button
                            type="button"
                            onClick={() => void removeUser(m)}
                            disabled={busy}
                            aria-label={`Remove ${name}`}
                            title="Remove from team"
                            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                          >
                            {busy ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
                          </button>
                        </>
                      ) : (
                        <RoleBadge role={m.role} />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {!canManage && members !== null && (
              <p className="mt-2 text-[11.5px] text-muted-foreground/80">
                Only admins and owners can add or manage members.
              </p>
            )}
          </div>

          {/* Danger zone — owner only */}
          {isOwner && (
            <div className="mt-6 border-t border-border/70 pt-5">
              {!confirmingDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
                >
                  <Trash2 className="size-4" />
                  Delete team
                </button>
              ) : (
                <div className="rounded-xl border border-destructive/30 bg-destructive/[0.04] p-3.5">
                  <div className="mb-1 flex items-center gap-2">
                    <AlertTriangle className="size-4 text-destructive" />
                    <h4 className="text-[13px] font-bold text-foreground">Delete this team?</h4>
                  </div>
                  <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
                    This permanently deletes{" "}
                    <span className="font-medium text-foreground">{team?.name}</span> and all of its shared
                    tasks. This can't be undone.
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                      Cancel
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => void removeTeam()} disabled={deleting}>
                      {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      Delete team
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ABOUTME: Manage a team — list members (avatar · name · email · role), invite by email (POST members
// with inline USER_NOT_FOUND / ALREADY_MEMBER handling), and an owner-only Delete team action with a
// confirm step. On delete we clear the active view and refresh teams + tasks (team tasks cascade away).
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Trash2, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Member, TeamRole } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { cn } from "@/lib/utils";
import { UserAvatar } from "@/components/common/bits";
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

const ROLE_LABEL: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

function memberName(m: Member): string {
  if (m.displayName) return m.displayName;
  if (m.email) return m.email.split("@")[0];
  return "Unknown";
}

function RoleBadge({ role }: { role: TeamRole }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-semibold",
        role === "owner"
          ? "bg-primary/12 text-primary"
          : "bg-muted text-muted-foreground",
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
  const [loadError, setLoadError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const teamId = team?.id ?? null;

  const load = useCallback(async () => {
    if (!teamId) return;
    setLoadError(null);
    setMembers(null);
    try {
      const { members } = await api.listMembers(teamId);
      setMembers(members);
    } catch (err) {
      setLoadError(errorMessage(err));
      setMembers([]);
    }
  }, [teamId]);

  // Fetch on open; reset transient UI state each time the dialog opens.
  useEffect(() => {
    if (open && teamId) {
      setEmail("");
      setInviteError(null);
      setConfirmingDelete(false);
      void load();
    }
  }, [open, teamId, load]);

  const myRole = members?.find((m) => m.userId === user.id)?.role;
  const isOwner = myRole === "owner";
  const canInvite = isOwner || myRole === "admin";
  // While members are loading (null) we optimistically allow typing; a load failure or a
  // known non-admin role disables invite. The hint explains which it is.
  const disableInvite = loadError !== null || (!canInvite && members !== null);
  const inviteHint = loadError
    ? "Couldn't reach the server. Reopen this dialog to try again."
    : canInvite || members === null
      ? "They need a be10x account already. New members join as a member."
      : "Only admins and owners can invite people.";

  async function invite() {
    const value = email.trim();
    if (!value || !teamId || inviting) return;
    setInviting(true);
    setInviteError(null);
    try {
      await api.addMember(teamId, value);
      // The POST returns only {userId, role}; refetch to get the full member card.
      await load();
      toast.success(`${value} added to ${team?.name ?? "the team"}.`);
      setEmail("");
    } catch (err) {
      if (err instanceof ApiError && err.code === "USER_NOT_FOUND") {
        setInviteError("No account found with that email. Ask them to sign up first.");
      } else if (err instanceof ApiError && err.code === "ALREADY_MEMBER") {
        setInviteError("They're already on this team.");
      } else if (err instanceof ApiError && err.code === "FORBIDDEN") {
        setInviteError("Only admins and owners can invite people.");
      } else {
        setInviteError(errorMessage(err));
      }
    } finally {
      setInviting(false);
    }
  }

  async function remove() {
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-[520px]">
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

        <div className="flex max-h-[70vh] flex-col overflow-y-auto scroll-thin px-6 py-5">
          {/* Members */}
          <div className="mb-5">
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
                  const name = memberName(m);
                  const isSelf = m.userId === user.id;
                  return (
                    <li
                      key={m.userId}
                      className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-2.5"
                    >
                      <UserAvatar name={name} seed={m.userId} size={30} ring={false} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold text-foreground">
                          {name}
                          {isSelf && (
                            <span className="ml-1.5 text-[11px] font-medium text-muted-foreground">
                              · you
                            </span>
                          )}
                        </p>
                        {m.email && (
                          <p className="truncate text-[11.5px] text-muted-foreground">{m.email}</p>
                        )}
                      </div>
                      <RoleBadge role={m.role} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Invite by email */}
          <div className="mb-1">
            <Label htmlFor="mt-invite" className="mb-1.5 block text-[12px] text-foreground/80">
              Invite by email
            </Label>
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <Input
                  id="mt-invite"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (inviteError) setInviteError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void invite();
                    }
                  }}
                  placeholder="teammate@company.com"
                  disabled={disableInvite}
                  aria-invalid={inviteError ? true : undefined}
                  className="h-9 bg-background text-[13px]"
                />
              </div>
              <Button
                onClick={() => void invite()}
                disabled={inviting || !email.trim() || disableInvite}
                className="h-9 shrink-0 text-[13px]"
              >
                {inviting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <>
                    <UserPlus className="size-4" />
                    Add
                  </>
                )}
              </Button>
            </div>
            {inviteError ? (
              <p className="mt-1.5 text-[12px] font-medium text-destructive" role="alert">
                {inviteError}
              </p>
            ) : (
              <p className="mt-1.5 text-[11.5px] text-muted-foreground/80">{inviteHint}</p>
            )}
          </div>

          {/* Danger zone — owner only */}
          {isOwner && (
            <div className="mt-5 border-t border-border/70 pt-5">
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
                    <span className="font-medium text-foreground">{team?.name}</span> and all of its
                    shared tasks. This can't be undone.
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deleting}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void remove()}
                      disabled={deleting}
                    >
                      {deleting ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <>
                          <Trash2 className="size-4" />
                          Delete team
                        </>
                      )}
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

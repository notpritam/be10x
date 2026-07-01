// ABOUTME: The signed-in user's profile — an identity header plus Details, Teams, and Agent access
// token cards. Read-only: pulls api.me() / api.listTeams() / api.listTokens() and renders them in the
// app's card style. Not wired into routing here; whoever mounts it owns placement.
import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, Loader2, Users } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { Team, TokenInfo, User } from "@/lib/types";
import { relativeTime } from "@/lib/utils";
import { UserAvatar } from "@/components/common/bits";

export function ProfilePage() {
  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [me, teamsRes, tokensRes] = await Promise.all([
          api.me(),
          api.listTeams(),
          api.listTokens(),
        ]);
        if (cancelled) return;
        setUser(me.user);
        setTeams(teamsRes.teams);
        setTokens(tokensRes.tokens);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin bg-background">
      <div className="w-full px-8 py-8 space-y-6">
        {loading ? (
          <div className="flex items-center gap-2 py-16 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading your profile…
          </div>
        ) : error ? (
          <div className="rounded-[12px] border border-destructive/30 bg-destructive/[0.04] px-4 py-3 text-[13px] text-destructive">
            {error}
          </div>
        ) : user ? (
          <>
            {/* Identity header */}
            <header className="flex items-center gap-4">
              <UserAvatar name={user.displayName} seed={user.id} size={64} ring={false} />
              <div className="min-w-0">
                <h1 className="truncate text-[22px] font-bold tracking-[-0.02em] text-foreground">
                  {user.displayName}
                </h1>
                <p className="truncate text-[13px] text-muted-foreground">{user.email}</p>
              </div>
            </header>

            {/* Details */}
            <Card title="Details">
              <dl>
                <Field label="Display name" value={user.displayName} />
                <Field label="Email" value={user.email} />
                <Field
                  label="Member since"
                  value={user.createdAt ? relativeTime(user.createdAt) : "—"}
                />
              </dl>
            </Card>

            {/* Teams */}
            <Card title="Teams" icon={<Users className="size-4" />}>
              {teams.length === 0 ? (
                <EmptyNote>You're not on any teams yet.</EmptyNote>
              ) : (
                <ul className="flex flex-col gap-1">
                  {teams.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5"
                    >
                      <UserAvatar name={t.name} seed={t.id} size={30} ring={false} />
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-foreground">{t.name}</p>
                        <p className="truncate text-[11.5px] text-muted-foreground">{t.slug}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Agent access tokens */}
            <Card title="Agent access tokens" icon={<KeyRound className="size-4" />}>
              {tokens.length === 0 ? (
                <EmptyNote>No tokens yet.</EmptyNote>
              ) : (
                <ul className="flex flex-col gap-1">
                  {tokens.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5"
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                        <KeyRound className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-foreground">{t.name}</p>
                        <p className="truncate text-[11.5px] text-muted-foreground">
                          Last used {t.lastUsedAt ? relativeTime(t.lastUsedAt) : "never"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-[11.5px] text-muted-foreground/80">
                Tokens are minted via{" "}
                <span className="font-medium text-foreground">Connect an agent</span>.
              </p>
            </Card>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[12px] border border-border/60 bg-card p-5 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-border/50 py-2.5 first:border-t-0 first:pt-0 last:pb-0">
      <dt className="shrink-0 text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-[13px] text-foreground">{value}</dd>
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border/70 px-3.5 py-6 text-center text-[12.5px] text-muted-foreground/70">
      {children}
    </p>
  );
}

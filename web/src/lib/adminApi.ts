// ABOUTME: A small, separate client for the admin dashboard — authenticated with a bearer token
// (GFA_ADMIN_TOKEN) the operator enters once, NOT the session cookie api.ts relies on. Kept apart
// from api.ts because the auth model is genuinely different, not just a different base path.

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface AdminOverview {
  userCount: number;
  activeUsers: number;
  taskCount: number;
  doneCount: number;
  usage: UsageTotals;
}

export interface AdminUserRow extends UsageTotals {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
  taskCount: number;
  tasksDone: number;
}

export interface AdminTaskRow extends UsageTotals {
  id: string;
  humanId: string;
  title: string;
  status: string;
  scope: string;
  teamId: string | null;
  createdAt: number;
}

export interface AdminUserDetail {
  user: { id: string; email: string; displayName: string; createdAt: number };
  tasks: AdminTaskRow[];
  totals: UsageTotals;
  tasksDone: number;
}

/** Thrown for both "wrong token" and "not found" — the API deliberately returns the same 404 for
 *  both, so the UI can't be used to probe whether a token is close-but-wrong. */
export class AdminAuthError extends Error {}

async function adminFetch<T>(token: string, path: string): Promise<T> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) throw new AdminAuthError("Invalid admin token, or this deploy has no GFA_ADMIN_TOKEN set.");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export const adminApi = {
  overview: (token: string) => adminFetch<AdminOverview>(token, "/api/admin/overview"),
  users: (token: string, q = "") =>
    adminFetch<{ users: AdminUserRow[] }>(token, `/api/admin/users${q ? "?q=" + encodeURIComponent(q) : ""}`),
  userDetail: (token: string, id: string) =>
    adminFetch<AdminUserDetail>(token, `/api/admin/users/${encodeURIComponent(id)}`),
};

const TOKEN_KEY = "gfa_admin_token";
export const loadAdminToken = (): string | null => sessionStorage.getItem(TOKEN_KEY);
export const saveAdminToken = (token: string) => sessionStorage.setItem(TOKEN_KEY, token);
export const clearAdminToken = () => sessionStorage.removeItem(TOKEN_KEY);

/** "1.2M" / "340K" / "89" — for token counts, where exact precision past 3 sig figs doesn't matter. */
export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatCost(usd: number): string {
  return usd < 0.01 && usd > 0 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

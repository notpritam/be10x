// ABOUTME: Typed wrapper over chrome.storage.local for the extension's config (board URL + auth token + user).
// ABOUTME: The only place that touches chrome.storage; keeps the SW and popup free of raw storage keys.
export type BoardUser = { displayName?: string; email?: string };
export type Config = { boardUrl?: string; token?: string; user?: BoardUser };

// Chrome resolves `localhost` to IPv6 `::1` first and its service-worker fetch does NOT fall back to
// IPv4, so a board bound only to 127.0.0.1 (the common local-dev case) refuses the connection and the
// report dies as "Failed to fetch". Pin the bare `localhost` host to 127.0.0.1 so it connects regardless
// of resolver order. Only an exact `localhost` host is rewritten — real hostnames (incl. `localhost.foo`)
// are left untouched.
export function normalizeBoardUrl(url?: string): string | undefined {
  if (!url) return url;
  return url.replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1');
}

export async function getConfig(): Promise<Config> {
  const c = (await chrome.storage.local.get(['boardUrl', 'token', 'user'])) as Config;
  return { ...c, boardUrl: normalizeBoardUrl(c.boardUrl) };
}
export async function setConfig(patch: Config): Promise<void> {
  await chrome.storage.local.set('boardUrl' in patch ? { ...patch, boardUrl: normalizeBoardUrl(patch.boardUrl) } : patch);
}
export async function clearAuth(): Promise<void> {
  await chrome.storage.local.remove(['token', 'user']);
}

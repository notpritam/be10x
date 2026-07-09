// ABOUTME: Typed wrapper over chrome.storage.local for the extension's config (board URL + auth token + user).
// ABOUTME: The only place that touches chrome.storage; keeps the SW and popup free of raw storage keys.
export type BoardUser = { displayName?: string; email?: string };
export type Config = { boardUrl?: string; token?: string; user?: BoardUser };

export async function getConfig(): Promise<Config> {
  return (await chrome.storage.local.get(['boardUrl', 'token', 'user'])) as Config;
}
export async function setConfig(patch: Config): Promise<void> {
  await chrome.storage.local.set(patch);
}
export async function clearAuth(): Promise<void> {
  await chrome.storage.local.remove(['token', 'user']);
}

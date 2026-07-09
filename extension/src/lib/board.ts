// ABOUTME: Pure board API client — thin typed wrappers over be10x REST. `f` is fetch (injected for tests);
// ABOUTME: no Chrome APIs here, so it unit-tests without a browser. The service worker supplies real fetch.
export type Fetch = typeof fetch;

async function post(f: Fetch, url: string, body: unknown, token?: string) {
  const res = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json && (json as any).error) || `HTTP_${res.status}`);
  return json as any;
}

export async function deviceStart(f: Fetch, boardUrl: string, label: string) {
  return post(f, boardUrl + '/api/device/code', { label });
}

export type BoardUser = { displayName?: string; email?: string };

export async function devicePoll(f: Fetch, boardUrl: string, deviceCode: string) {
  const r = await post(f, boardUrl + '/api/device/token', { deviceCode });
  if (r && r.token) return { status: 'approved' as const, token: r.token as string, user: (r.user ?? null) as BoardUser | null };
  if (r && r.status === 'denied') return { status: 'denied' as const };
  return { status: 'pending' as const };
}

export async function mintUploadUrls(
  f: Fetch, boardUrl: string, token: string,
  files: { name: string; size: number; type: string }[]
) {
  return post(f, boardUrl + '/api/agent/bugs/upload-urls', { files }, token);
}

export async function fileBug(f: Fetch, boardUrl: string, token: string, payload: Record<string, unknown>) {
  return post(f, boardUrl + '/api/agent/bugs', payload, token);
}

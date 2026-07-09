// ABOUTME: Unit tests for the pure board API client using a stub fetch — no Chrome, no network.
// ABOUTME: Verifies path/method routing, bearer headers, response mapping, and non-ok error surfacing.
import { describe, it, expect } from 'vitest';
import { deviceStart, devicePoll, mintUploadUrls, fileBug } from './board';

function stub(routes: Record<string, (o: any) => any>) {
  return async (url: string, opts?: any) => {
    const key = (opts?.method || 'GET') + ' ' + new URL(url).pathname;
    const entry = routes[key];
    if (!entry) return { ok: false, status: 404, json: async () => ({ error: 'NOT_FOUND' }) };
    return { ok: true, status: 200, json: async () => entry(opts) };
  };
}

describe('board client', () => {
  it('deviceStart posts a label and returns the codes', async () => {
    const f = stub({
      'POST /api/device/code': (o) => {
        expect(JSON.parse(o.body).label).toBe('Chrome on QA-laptop');
        return { deviceCode: 'dc', userCode: 'WXYZ', verificationUriComplete: 'https://b/connect?code=WXYZ', interval: 2, expiresIn: 600 };
      },
    });
    const r = await deviceStart(f as any, 'https://b', 'Chrome on QA-laptop');
    expect(r.userCode).toBe('WXYZ');
  });

  it('devicePoll maps pending / approved', async () => {
    const pending = stub({ 'POST /api/device/token': () => ({ status: 'pending' }) });
    expect((await devicePoll(pending as any, 'https://b', 'dc')).status).toBe('pending');
    const approved = stub({ 'POST /api/device/token': () => ({ token: 'gfa_x', status: 'approved' }) });
    const r = await devicePoll(approved as any, 'https://b', 'dc');
    expect(r).toEqual({ status: 'approved', token: 'gfa_x' });
  });

  it('mintUploadUrls sends the bearer token and files, returns uploads', async () => {
    const f = stub({
      'POST /api/agent/bugs/upload-urls': (o) => {
        expect(o.headers.Authorization).toBe('Bearer gfa_x');
        expect(JSON.parse(o.body).files[0].name).toBe('shot.png');
        return { uploads: [{ key: 'K', uploadUrl: 'https://ut/K', fileUrl: 'https://f/K', name: 'shot.png' }] };
      },
    });
    const r = await mintUploadUrls(f as any, 'https://b', 'gfa_x', [{ name: 'shot.png', size: 1, type: 'image/png' }]);
    expect(r.uploads[0].key).toBe('K');
  });

  it('fileBug posts the payload with the bearer token', async () => {
    const f = stub({
      'POST /api/agent/bugs': (o) => {
        expect(o.headers.Authorization).toBe('Bearer gfa_x');
        return { bug: { id: 'b1', humanId: 'BUG-001' } };
      },
    });
    const r = await fileBug(f as any, 'https://b', 'gfa_x', { pageUrl: 'p', title: 't' });
    expect(r.bug.humanId).toBe('BUG-001');
  });

  it('throws a useful error on a non-ok response', async () => {
    const f = async () => ({ ok: false, status: 400, json: async () => ({ error: 'MISSING_FIELD:UPLOADTHING_TOKEN' }) });
    await expect(mintUploadUrls(f as any, 'https://b', 'gfa_x', [])).rejects.toThrow('MISSING_FIELD:UPLOADTHING_TOKEN');
  });
});

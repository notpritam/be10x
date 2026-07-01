import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/http/server.js';

async function withServer(fn) {
  const db = openDb(':memory:');
  const app = createApp(db);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => app.close(r));
  }
}

async function api(base, method, path, { cookie, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  const sid = setCookie ? setCookie.split(';')[0] : cookie;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: sid };
}

const signup = (base, email) =>
  api(base, 'POST', '/api/auth/signup', { body: { email, displayName: email[0].toUpperCase(), password: 'pw12345' } });

test('creating a token returns the plaintext secret once', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'a@b.co');
    const created = await api(base, 'POST', '/api/tokens', { cookie: a.cookie, body: { name: 'ci' } });
    assert.equal(created.status, 200);
    assert.ok(created.json.token, 'response has a token object');
    assert.equal(created.json.token.name, 'ci');
    assert.ok(created.json.token.id, 'token has an id');
    assert.match(created.json.token.token, /^gfa_[0-9a-f]{48}$/, 'plaintext secret is returned');
  });
});

test('POST /api/tokens defaults the name to "agent"', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'a@b.co');
    const created = await api(base, 'POST', '/api/tokens', { cookie: a.cookie, body: {} });
    assert.equal(created.status, 200);
    assert.equal(created.json.token.name, 'agent');
  });
});

test('GET /api/tokens lists tokens WITHOUT ever exposing the secret or its hash', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'a@b.co');
    await api(base, 'POST', '/api/tokens', { cookie: a.cookie, body: { name: 'ci' } });

    const list = await api(base, 'GET', '/api/tokens', { cookie: a.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.json.tokens.length, 1);
    const row = list.json.tokens[0];
    assert.equal(row.name, 'ci');
    assert.ok(row.id, 'listed token has an id');
    assert.ok('createdAt' in row, 'listed token exposes createdAt');
    assert.ok('lastUsedAt' in row, 'listed token exposes lastUsedAt');
    // The plaintext secret and stored hash must never be listed.
    assert.ok(!('token' in row), 'must not expose the plaintext secret');
    assert.ok(!('token_hash' in row), 'must not expose the token hash');
    assert.ok(!('tokenHash' in row), 'must not expose the token hash');
    assert.ok(!('secret' in row), 'must not expose a secret field');
  });
});

test('a second user cannot delete the first user\'s token (404) and it still lists for the owner', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'a@b.co');
    const b = await signup(base, 'b@b.co');
    const created = await api(base, 'POST', '/api/tokens', { cookie: a.cookie, body: { name: 'ci' } });
    const tokenId = created.json.token.id;

    const denied = await api(base, 'DELETE', '/api/tokens/' + tokenId, { cookie: b.cookie });
    assert.equal(denied.status, 404);
    assert.equal(denied.json.error, 'NOT_FOUND');

    // The owner's token survives the failed cross-user delete.
    const stillThere = await api(base, 'GET', '/api/tokens', { cookie: a.cookie });
    assert.equal(stillThere.json.tokens.length, 1);
    assert.equal(stillThere.json.tokens[0].id, tokenId);
  });
});

test('the owner can revoke their own token', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'a@b.co');
    const created = await api(base, 'POST', '/api/tokens', { cookie: a.cookie, body: { name: 'ci' } });
    const tokenId = created.json.token.id;

    const revoked = await api(base, 'DELETE', '/api/tokens/' + tokenId, { cookie: a.cookie });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.json.ok, true);

    const list = await api(base, 'GET', '/api/tokens', { cookie: a.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.json.tokens.length, 0);
  });
});

test('the team owner can delete the team; a non-owner member gets 403', async () => {
  await withServer(async (base) => {
    const owner = await signup(base, 'owner@b.co');
    const member = await signup(base, 'member@b.co');
    const team = await api(base, 'POST', '/api/teams', { cookie: owner.cookie, body: { name: 'Alpha' } });
    const teamId = team.json.team.id;
    // Add the second user as a plain member (rank below owner).
    await api(base, 'POST', '/api/teams/' + teamId + '/members', { cookie: owner.cookie, body: { email: 'member@b.co' } });

    // A non-owner member cannot delete the team.
    const denied = await api(base, 'DELETE', '/api/teams/' + teamId, { cookie: member.cookie });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'FORBIDDEN');
    // The team is still there for the owner after the forbidden attempt.
    const before = await api(base, 'GET', '/api/teams', { cookie: owner.cookie });
    assert.ok(before.json.teams.some((t) => t.id === teamId), 'team survives a forbidden delete');

    // The owner can delete it.
    const ok = await api(base, 'DELETE', '/api/teams/' + teamId, { cookie: owner.cookie });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);

    // A follow-up listing no longer includes the team.
    const after = await api(base, 'GET', '/api/teams', { cookie: owner.cookie });
    assert.ok(!after.json.teams.some((t) => t.id === teamId), 'deleted team is no longer listed');
  });
});

test('GET /api/agent-config returns an absolute mcpServerPath ending in src/mcp/server.js', async () => {
  await withServer(async (base) => {
    const a = await signup(base, 'a@b.co');
    const cfg = await api(base, 'GET', '/api/agent-config', { cookie: a.cookie });
    assert.equal(cfg.status, 200);
    assert.ok(cfg.json.mcpServerPath.startsWith('/'), 'mcpServerPath is absolute');
    assert.ok(cfg.json.mcpServerPath.endsWith('src/mcp/server.js'), 'mcpServerPath points at the MCP server');
    assert.equal(typeof cfg.json.dbPath, 'string');
  });
});

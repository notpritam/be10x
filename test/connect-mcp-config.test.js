// ABOUTME: writeMcpConfig (used by `be10x connect` / `be10x link` remote) must wire BOTH the task gfa_* MCP
// ABOUTME: (be10x → http-server.js) AND the bug-context MCP (be10x-bugs → bug-http-server.js), pointed at the
// ABOUTME: hosted board over HTTP — so the remote agent gets bug capture tools, not just task tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMcpConfig } from '../src/connect/connect.js';

function writeTo(opts) {
  const dir = mkdtempSync(join(tmpdir(), 'be10x-mcp-'));
  const out = writeMcpConfig(dir, opts);
  return JSON.parse(readFileSync(out, 'utf8'));
}

test('writes both be10x (tasks) and be10x-bugs (capture) servers pointed at the board', () => {
  const cfg = writeTo({
    board: 'https://board.test',
    token: 'gfa_abc',
    httpMcpServerPath: '/opt/be10x/src/mcp/http-server.js',
    bugHttpMcpServerPath: '/opt/be10x/src/mcp/bug-http-server.js',
  });
  const servers = cfg.mcpServers;

  assert.equal(servers.be10x.command, 'node');
  assert.deepEqual(servers.be10x.args, ['/opt/be10x/src/mcp/http-server.js']);
  assert.deepEqual(servers.be10x.env, { GFA_BOARD_URL: 'https://board.test', GFA_TOKEN: 'gfa_abc' });

  assert.equal(servers['be10x-bugs'].command, 'node');
  assert.deepEqual(servers['be10x-bugs'].args, ['/opt/be10x/src/mcp/bug-http-server.js']);
  assert.equal(servers['be10x-bugs'].env.GFA_BOARD_URL, 'https://board.test');
  assert.equal(servers['be10x-bugs'].env.GFA_TOKEN, 'gfa_abc');
  // No UPLOADTHING_TOKEN when none was supplied.
  assert.equal(servers['be10x-bugs'].env.UPLOADTHING_TOKEN, undefined);
});

test('bugHttpMcpServerPath defaults to the sibling of httpMcpServerPath when omitted', () => {
  const cfg = writeTo({ board: 'https://b.test', token: 't', httpMcpServerPath: '/x/y/src/mcp/http-server.js' });
  assert.deepEqual(cfg.mcpServers['be10x-bugs'].args, ['/x/y/src/mcp/bug-http-server.js']);
});

test('passes UPLOADTHING_TOKEN through to the be10x-bugs env when provided', () => {
  const cfg = writeTo({
    board: 'https://b.test', token: 't',
    httpMcpServerPath: '/x/http-server.js', bugHttpMcpServerPath: '/x/bug-http-server.js',
    uploadthingToken: 'ut_secret',
  });
  assert.equal(cfg.mcpServers['be10x-bugs'].env.UPLOADTHING_TOKEN, 'ut_secret');
  // The task server never carries the artifact token.
  assert.equal(cfg.mcpServers.be10x.env.UPLOADTHING_TOKEN, undefined);
});

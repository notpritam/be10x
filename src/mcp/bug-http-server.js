#!/usr/bin/env node
// ABOUTME: HTTP-transport MCP server for be10x-bugs — the REMOTE sibling of bug-server.js, for an agent on a
// ABOUTME: MEMBER's machine (`be10x connect`) against a HOSTED board. Same bug tool LIST; each call is
// ABOUTME: forwarded to the board's /api/agent/bug-rpc gateway (Bearer GFA_TOKEN).
//
// bug-server.js (stdio) opens a LOCAL SQLite db and runs each bug_* handler in-process — it only works when
// the board and the agent share a machine. This variant instead forwards every tools/call to the board's
// token-authed bug gateway (POST {GFA_BOARD_URL}/api/agent/bug-rpc), which runs the tool server-side against
// the board db WITH per-account bug-access authz. The tool LIST is pure metadata (no db), so the agent sees
// an identical be10x-bugs toolset — only the call path changes. Mirrors src/mcp/http-server.js (the gfa_*
// twin), which forwards to /api/agent/rpc.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { BUG_TOOLS } from './bug-tools.js';

const BOARD = process.env.GFA_BOARD_URL || '';
const TOKEN = process.env.GFA_TOKEN || '';

// Forward one bug_* call to the board's bug-rpc gateway and return its result. Throws with the board's domain
// error (NO_BUG, FORBIDDEN, NO_ARTIFACT:*, …) on a non-2xx so the caller surfaces it like the stdio server
// does. `fetchImpl` is injected for tests; the board URL is normalised (no trailing slash) so paths never
// double.
export async function callBoardBug(tool, args, { board = BOARD, token = TOKEN, fetchImpl = fetch } = {}) {
  const base = String(board || '').replace(/\/+$/, '');
  if (!base) throw new Error('GFA_BOARD_URL is not set');
  const res = await fetchImpl(base + '/api/agent/bug-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ tool, args: args ?? {} }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
  return json.result ?? null;
}

// Build the MCP server whose tools/call forwards over HTTP. Options (board/token/fetchImpl) flow through to
// callBoardBug, so tests can drive it without a real board or env.
export function makeHttpBugMcpServer(opts = {}) {
  const server = new Server({ name: 'be10x-bugs', version: '0.0.1' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BUG_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!BUG_TOOLS.some((t) => t.name === req.params.name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
    }
    try {
      const result = await callBoardBug(req.params.name, req.params.arguments ?? {}, opts);
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (err) {
      // Surface board/domain errors as tool errors (never crash the transport).
      return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
    }
  });

  return server;
}

// Run stdio only as the entrypoint (Claude Code spawns `node bug-http-server.js`), not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (!BOARD) {
    console.error('be10x-bugs HTTP MCP: set GFA_BOARD_URL (the board base URL) and GFA_TOKEN (a personal access token).');
    process.exit(1);
  }
  const server = makeHttpBugMcpServer();
  await server.connect(new StdioServerTransport());
}

#!/usr/bin/env node
// ABOUTME: HTTP-transport MCP server for be10x — the sibling of server.js for an agent running on a
// ABOUTME: MEMBER's own machine against a HOSTED board. Same tool list; each call is forwarded to /rpc.
//
// server.js (stdio) opens a LOCAL SQLite db and runs each gfa_* tool handler in-process — it only works
// when the board and the agent share a machine. This variant instead forwards every tools/call to the
// board's token-authed gateway (POST {GFA_BOARD_URL}/api/agent/rpc with Authorization: Bearer GFA_TOKEN),
// so a member's local agent drives a board across the network. The tool LIST is pure metadata (no db), so
// the agent sees an identical toolset — only the call path changes.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { TOOLS } from './tools.js';

const BOARD = process.env.GFA_BOARD_URL || '';
const TOKEN = process.env.GFA_TOKEN || '';

// Forward one gfa_* call to the board's RPC gateway and return its result. Throws with the board's domain
// error (NO_TASK, MISSING_FIELD:*, …) on a non-2xx so the caller surfaces it like the stdio server does.
// `fetchImpl` is injected for tests; the board URL is normalised (no trailing slash) so paths never double.
export async function callBoard(tool, args, { board = BOARD, token = TOKEN, fetchImpl = fetch } = {}) {
  const base = String(board || '').replace(/\/+$/, '');
  if (!base) throw new Error('GFA_BOARD_URL is not set');
  const res = await fetchImpl(base + '/api/agent/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ tool, args: args ?? {} }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
  return json.result ?? null;
}

// Build the MCP server whose tools/call forwards over HTTP. Options (board/token/fetchImpl) flow through to
// callBoard, so tests can drive it without a real board or env.
export function makeHttpMcpServer(opts = {}) {
  const server = new Server({ name: 'be10x', version: '0.0.1' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!TOOLS.some((t) => t.name === req.params.name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
    }
    try {
      const result = await callBoard(req.params.name, req.params.arguments ?? {}, opts);
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (err) {
      // Surface board/domain errors as tool errors (never crash the transport).
      return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
    }
  });

  return server;
}

// Run stdio only as the entrypoint (Claude Code spawns `node http-server.js`), not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (!BOARD) {
    console.error('be10x HTTP MCP: set GFA_BOARD_URL (the board base URL) and GFA_TOKEN (a personal access token).');
    process.exit(1);
  }
  const server = makeHttpMcpServer();
  await server.connect(new StdioServerTransport());
}

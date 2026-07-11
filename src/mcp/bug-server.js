#!/usr/bin/env node
// ABOUTME: Thin stdio MCP server exposing a filed bug's full capture as agent tools — "paste a bug link and
// ABOUTME: the agent debugs it". Logic lives in bug-tools.js; this is wiring: open the db, auth each call via
// ABOUTME: GFA_TOKEN, dispatch to BUG_TOOLS. Handlers may be async (artifact fetch), so calls are awaited.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { openDb } from '../db/db.js';
import { verifyToken } from '../auth/tokens.js';
import { BUG_TOOLS, getBugTool } from './bug-tools.js';

const db = openDb(process.env.GFA_DB_PATH || './gfa.db');

const server = new Server({ name: 'be10x-bugs', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: BUG_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = getBugTool(req.params.name);
  if (!tool) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);

  // Every call is bearer-authenticated against a personal access token — bugs are board-wide (no per-bug
  // owner), so a valid token grants read; there is nothing to mutate here.
  const ctx = verifyToken(db, process.env.GFA_TOKEN ?? '');
  if (!ctx) throw new McpError(ErrorCode.InvalidRequest, 'Unauthorized: set a valid GFA_TOKEN personal access token.');

  try {
    const result = await tool.handler(db, ctx, req.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
  } catch (err) {
    // Surface domain errors (NO_BUG, NO_ARTIFACT:*, ARTIFACT_UNAVAILABLE, ...) as tool errors, not crashes.
    return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
  }
});

await server.connect(new StdioServerTransport());

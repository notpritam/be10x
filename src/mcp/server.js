#!/usr/bin/env node
// ABOUTME: Thin stdio MCP server for be10x. All logic lives in tools.js — this is pure wiring:
// ABOUTME: open the db, authenticate each tools/call via GFA_TOKEN, and dispatch to the TOOLS registry.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { openDb } from '../db/db.js';
import { verifyToken } from '../auth/tokens.js';
import { TOOLS, getTool } from './tools.js';

const db = openDb(process.env.GFA_DB_PATH || './gfa.db');

const server = new Server({ name: 'be10x', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = getTool(req.params.name);
  if (!tool) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);

  // Authenticate every call against a personal access token — never crash on a bad/missing token.
  const ctx = verifyToken(db, process.env.GFA_TOKEN ?? '');
  if (!ctx) throw new McpError(ErrorCode.InvalidRequest, 'Unauthorized: set a valid GFA_TOKEN personal access token.');

  try {
    const result = tool.handler(db, ctx, req.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
  } catch (err) {
    // Surface core domain errors (ILLEGAL_TRANSITION, MISSING_FIELD:*, NO_TASK, ...) as tool errors.
    return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
  }
});

await server.connect(new StdioServerTransport());

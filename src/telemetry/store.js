// ABOUTME: The server-side half of telemetry — validates and stores a batch a CLI install POSTs
// ABOUTME: to /api/telemetry. Defense in depth: the endpoint is public, so every field is capped.
import { randomUUID } from 'node:crypto';
import { MAX_EVENTS_PER_BATCH } from './telemetry.js';

const MAX_PAYLOAD_CHARS = 30000; // above the client's MAX_CONTENT_CHARS to allow for JSON overhead

function clampString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

// Stores whatever of the batch is well-formed and silently drops the rest — a malformed or
// oversized individual event shouldn't fail the whole batch (the CLI would just keep retrying
// forever otherwise). Returns how many rows were actually written.
export function recordTelemetryBatch(db, { installId, cliVersion, os, nodeVersion, events } = {}) {
  const id = clampString(installId, 100);
  if (!id) throw new Error('MISSING_FIELD:installId');
  const version = clampString(cliVersion, 40);
  const platform = clampString(os, 40);
  const node = clampString(nodeVersion, 40);
  const list = Array.isArray(events) ? events.slice(0, MAX_EVENTS_PER_BATCH) : [];

  const now = Date.now();
  const insert = db.prepare(
    'INSERT INTO telemetry_events (id, install_id, event, cli_version, os, node_version, payload_json, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  let written = 0;
  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.event !== 'string' || !e.event.trim()) continue;
    const { event, occurredAt, ...rest } = e;
    const payload = JSON.stringify(rest).slice(0, MAX_PAYLOAD_CHARS);
    insert.run(randomUUID(), id, event.slice(0, 60), version, platform, node, payload, Number.isFinite(occurredAt) ? occurredAt : null, now);
    written++;
  }
  return { received: written };
}

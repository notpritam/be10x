// ABOUTME: The opt-in telemetry core — config persistence, env-override precedence, the local
// ABOUTME: queue (record/flush/truncate/cap), and the injectable first-run consent prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTelemetryConfig,
  saveTelemetryConfig,
  setTelemetryEnabled,
  effectiveEnabled,
  recordEvent,
  flushQueue,
  promptForConsent,
  MAX_CONTENT_CHARS,
  MAX_EVENTS_PER_BATCH,
} from '../src/telemetry/telemetry.js';

function tmpPath(name) {
  return join(mkdtempSync(join(tmpdir(), 'gfa-telemetry-')), name);
}

test('loadTelemetryConfig returns null when nothing is on disk yet', () => {
  assert.equal(loadTelemetryConfig(tmpPath('telemetry.json')), null);
});

test('setTelemetryEnabled generates an installId once and keeps it across later toggles', () => {
  const path = tmpPath('telemetry.json');
  const first = setTelemetryEnabled(true, path);
  assert.ok(first.installId);
  assert.equal(first.enabled, true);

  const second = setTelemetryEnabled(false, path);
  assert.equal(second.installId, first.installId, 'toggling off must not mint a new install id');
  assert.equal(second.enabled, false);

  assert.deepEqual(loadTelemetryConfig(path), second);
});

test('effectiveEnabled: no override and no stored decision is undefined (caller should prompt)', () => {
  assert.equal(effectiveEnabled({}, null), undefined);
});

test('effectiveEnabled: stored decision is used when there is no env override', () => {
  assert.equal(effectiveEnabled({}, { enabled: true }), true);
  assert.equal(effectiveEnabled({}, { enabled: false }), false);
});

test('effectiveEnabled: GFA_TELEMETRY env var overrides a stored decision in both directions', () => {
  assert.equal(effectiveEnabled({ GFA_TELEMETRY: '0' }, { enabled: true }), false);
  assert.equal(effectiveEnabled({ GFA_TELEMETRY: '1' }, { enabled: false }), true);
  assert.equal(effectiveEnabled({ GFA_TELEMETRY: 'false' }, { enabled: true }), false);
  assert.equal(effectiveEnabled({ GFA_TELEMETRY: 'true' }, { enabled: false }), true);
});

test('recordEvent is a no-op when not enabled — never creates the queue file', () => {
  const path = tmpPath('queue.ndjson');
  recordEvent('cli_command', { command: 'link' }, { enabled: false, path });
  assert.equal(existsSync(path), false);
});

test('recordEvent appends an NDJSON line with a timestamp when enabled', () => {
  const path = tmpPath('queue.ndjson');
  recordEvent('cli_command', { command: 'link', ok: true }, { enabled: true, path });
  recordEvent('cli_command', { command: 'connect', ok: false }, { enabled: true, path });
  const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'cli_command');
  assert.equal(lines[0].command, 'link');
  assert.ok(lines[0].occurredAt);
  assert.equal(lines[1].command, 'connect');
});

test('recordEvent truncates oversized string fields so one huge plan can\'t grow the queue unbounded', () => {
  const path = tmpPath('queue.ndjson');
  const huge = 'x'.repeat(MAX_CONTENT_CHARS + 500);
  recordEvent('task_run', { content: huge }, { enabled: true, path });
  const [line] = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(line.content.length < huge.length);
  assert.ok(line.content.endsWith('…[truncated]'));
});

test('recordEvent leaves a small object field (e.g. task content) intact', () => {
  const path = tmpPath('queue.ndjson');
  recordEvent('task_run', { content: { summary: 'small' } }, { enabled: true, path });
  const [line] = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(line.content, { summary: 'small' });
});

test('recordEvent replaces an oversized object field (e.g. a big plan) with a bounded preview', () => {
  const path = tmpPath('queue.ndjson');
  const bigPlan = { steps: Array.from({ length: 5000 }, (_, i) => 'step ' + i) };
  recordEvent('task_run', { plan: bigPlan }, { enabled: true, path });
  const [line] = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(line.plan.truncated, true);
  assert.ok(line.plan.preview.length <= MAX_CONTENT_CHARS);
});

test('flushQueue does nothing (and never throws) when the queue is empty', async () => {
  const path = tmpPath('queue.ndjson');
  const result = await flushQueue({ installId: 'i1', path, fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(result.sent, 0);
});

test('flushQueue does nothing when installId is missing (no decision made yet)', async () => {
  const path = tmpPath('queue.ndjson');
  recordEvent('cli_command', { command: 'link' }, { enabled: true, path });
  const result = await flushQueue({ installId: undefined, path, fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(result.sent, 0);
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1, 'queue is left untouched');
});

test('flushQueue POSTs the batch and clears the queue on success', async () => {
  const path = tmpPath('queue.ndjson');
  recordEvent('cli_command', { command: 'link' }, { enabled: true, path });
  recordEvent('cli_command', { command: 'connect' }, { enabled: true, path });

  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true };
  };
  const result = await flushQueue({ installId: 'install-1', cliVersion: '0.1.0', path, fetchImpl });

  assert.equal(result.sent, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.installId, 'install-1');
  assert.equal(calls[0].body.events.length, 2);
  assert.equal(readFileSync(path, 'utf8'), '', 'sent events are cleared from the queue');
});

test('flushQueue leaves the queue untouched on a network failure', async () => {
  const path = tmpPath('queue.ndjson');
  recordEvent('cli_command', { command: 'link' }, { enabled: true, path });
  const result = await flushQueue({ installId: 'i1', path, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(result.sent, 0);
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1);
});

test('flushQueue leaves the queue untouched on a non-2xx response', async () => {
  const path = tmpPath('queue.ndjson');
  recordEvent('cli_command', { command: 'link' }, { enabled: true, path });
  const result = await flushQueue({ installId: 'i1', path, fetchImpl: async () => ({ ok: false }) });
  assert.equal(result.sent, 0);
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1);
});

test('flushQueue caps the batch size and leaves the remainder queued', async () => {
  const path = tmpPath('queue.ndjson');
  for (let i = 0; i < MAX_EVENTS_PER_BATCH + 10; i++) {
    recordEvent('cli_command', { command: 'link', i }, { enabled: true, path });
  }
  let sentCount = 0;
  const result = await flushQueue({
    installId: 'i1',
    path,
    fetchImpl: async (url, opts) => {
      sentCount = JSON.parse(opts.body).events.length;
      return { ok: true };
    },
  });
  assert.equal(sentCount, MAX_EVENTS_PER_BATCH);
  assert.equal(result.sent, MAX_EVENTS_PER_BATCH);
  const remaining = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(remaining.length, 10);
});

test('promptForConsent skips (returns null) in a non-interactive context, without asking', async () => {
  const ask = async () => { throw new Error('should not be called when non-interactive'); };
  const result = await promptForConsent({ ask, isTTY: false });
  assert.equal(result, null);
});

test('promptForConsent asks and parses a yes/no answer', async () => {
  assert.equal(await promptForConsent({ ask: async () => 'y', isTTY: true }), true);
  assert.equal(await promptForConsent({ ask: async () => 'yes', isTTY: true }), true);
  assert.equal(await promptForConsent({ ask: async () => 'n', isTTY: true }), false);
  assert.equal(await promptForConsent({ ask: async () => '', isTTY: true }), false, 'blank (just Enter) defaults to no');
});

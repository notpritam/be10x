// ABOUTME: Tests the optional new-bug webhook notification — payload format, the no-webhook no-op (must not
// ABOUTME: fetch), a mocked successful POST, and that a webhook failure is swallowed (never breaks ingest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBugNotification, notifyBugFiled } from '../src/bugs/notify.js';

const BUG = {
  id: 'b1',
  humanId: 'BUG-009',
  title: 'Pay button dead',
  severity: 'high',
  status: 'open',
  pageUrl: 'https://app.example.com/checkout',
};

test('buildBugNotification produces a Slack-compatible payload', () => {
  const p = buildBugNotification(BUG, { boardOrigin: 'https://be10x.notpritam.in' });
  assert.match(p.text, /New bug \*BUG-009\* \(high\): Pay button dead/);
  assert.match(p.text, /https:\/\/app\.example\.com\/checkout/);
  assert.match(p.text, /https:\/\/be10x\.notpritam\.in/);
  assert.equal(p.bug.humanId, 'BUG-009');
  assert.equal(p.bug.severity, 'high');
});

test('notifyBugFiled does NOT fetch when no webhook is configured', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true };
  };
  const out = await notifyBugFiled(BUG, { webhook: '', fetchImpl });
  assert.equal(out.sent, false);
  assert.equal(called, false);
});

test('notifyBugFiled POSTs the payload when a webhook is set', async () => {
  let sentUrl = null;
  let sentBody = null;
  const fetchImpl = async (url, init) => {
    sentUrl = url;
    sentBody = JSON.parse(init.body);
    return { ok: true };
  };
  const out = await notifyBugFiled(BUG, { webhook: 'https://hooks.example.com/x', boardOrigin: 'https://be10x', fetchImpl });
  assert.equal(out.sent, true);
  assert.equal(sentUrl, 'https://hooks.example.com/x');
  assert.match(sentBody.text, /BUG-009/);
});

test('notifyBugFiled swallows a webhook failure (never breaks ingest)', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const out = await notifyBugFiled(BUG, { webhook: 'https://hooks.example.com/x', fetchImpl });
  assert.equal(out.sent, false);
});

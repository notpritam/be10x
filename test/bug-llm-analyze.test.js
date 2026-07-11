// ABOUTME: Tests the optional LLM RCA — the no-key degrade path, a mocked Anthropic call, the cache setter,
// ABOUTME: and the privacy invariant that test credentials / auth are NEVER put in the prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createBug, getBug, setBugLlmAnalysis } from '../src/bugs/bugs.js';
import { analyzeBug } from '../src/bugs/analyze.js';
import { buildRcaPrompt, llmAnalyzeBug } from '../src/bugs/llm-analyze.js';

function seedBug() {
  const db = openDb(':memory:');
  const user = createUser(db, { email: 'qa@b.co', displayName: 'QA', password: 'pw123456' });
  const bug = createBug(db, {
    reporterId: user.id,
    pageUrl: 'https://app.example.com/checkout',
    title: 'Pay button dead',
    severity: 'high',
    meta: {
      notes: 'Click pay, nothing happens',
      console: [{ ts: 1, level: 'error', text: "TypeError: total is undefined at Pay.tsx:42" }],
      pickedElements: [{ selector: 'button#pay', tag: 'BUTTON', rect: { x: 0, y: 0, w: 1, h: 1 }, react: { component: 'PayButton', source: 'src/checkout/Pay.tsx:42' } }],
      credentials: { username: 'qa@example.com', password: 'SuperSecret123!' },
      environment: { brands: ['Chrome 152'], platform: 'macOS' },
    },
  });
  return { db, bug };
}

test('buildRcaPrompt includes the technical signals but NEVER the credentials', () => {
  const { bug } = seedBug();
  const prompt = buildRcaPrompt(bug, { heuristic: analyzeBug(bug), networkFailures: [{ method: 'POST', url: '/api/pay', status: 500 }] });
  assert.match(prompt, /TypeError: total is undefined/);
  assert.match(prompt, /PayButton/);
  assert.match(prompt, /POST \/api\/pay -> 500/);
  // The privacy invariant: the test password + username must never reach the model.
  assert.doesNotMatch(prompt, /SuperSecret123!/);
  assert.doesNotMatch(prompt, /qa@example\.com/);
});

test('llmAnalyzeBug throws NO_LLM_KEY when no key is configured', async () => {
  const { bug } = seedBug();
  await assert.rejects(() => llmAnalyzeBug(bug, { key: '' }), /NO_LLM_KEY/);
});

test('llmAnalyzeBug calls the API (mocked) and parses the text', async () => {
  const { bug } = seedBug();
  let sentUrl = null;
  let sentBody = null;
  const fetchImpl = async (url, init) => {
    sentUrl = url;
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ROOT CAUSE: undefined total.' }] }) };
  };
  const out = await llmAnalyzeBug(bug, { key: 'test-key', model: 'claude-haiku-4-5-20251001', fetchImpl, now: 123 });
  assert.equal(sentUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(sentBody.model, 'claude-haiku-4-5-20251001');
  assert.equal(out.text, 'ROOT CAUSE: undefined total.');
  assert.equal(out.generatedAt, 123);
});

test('llmAnalyzeBug surfaces a non-OK API response as an error', async () => {
  const { bug } = seedBug();
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'invalid key' });
  await assert.rejects(() => llmAnalyzeBug(bug, { key: 'bad', fetchImpl }), /LLM_HTTP_401/);
});

test('setBugLlmAnalysis caches the analysis on the bug meta', () => {
  const { db, bug } = seedBug();
  const updated = setBugLlmAnalysis(db, bug.id, { text: 'cached', model: 'm', generatedAt: 1 });
  assert.equal(updated.meta.llmAnalysis.text, 'cached');
  // Re-read to confirm it persisted.
  assert.equal(getBug(db, bug.id).meta.llmAnalysis.text, 'cached');
  // Original capture signals survive the merge.
  assert.equal(getBug(db, bug.id).meta.pickedElements.length, 1);
});

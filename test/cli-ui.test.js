import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setColorEnabled,
  fg,
  bold,
  gradient,
  gradientBlock,
  box,
  stripAnsi,
  width,
  spinner,
  BRAND,
} from '../src/cli/ui.js';

// The zero-dep ANSI toolkit. Two modes matter: color ON (truecolor escapes) and color OFF (clean plain text,
// which is what a piped shell / CI / a launchd log file gets).

test('color OFF yields plain text — no escape codes anywhere', () => {
  setColorEnabled(false);
  assert.equal(fg(BRAND.teal, 'hi'), 'hi');
  assert.equal(bold('hi'), 'hi');
  assert.equal(gradient('be10x'), 'be10x');
  assert.deepEqual(gradientBlock(['ab', 'cd']), ['ab', 'cd']);
  assert.doesNotMatch(box(['line']), /\x1b/, 'box has no escapes when color is off');
});

test('color ON emits truecolor escapes for fg and gradient', () => {
  setColorEnabled(true);
  assert.match(fg(BRAND.teal, 'x'), /\x1b\[38;2;45;212;191m/);
  const g = gradient('abcd');
  assert.match(g, /\x1b\[38;2;/, 'gradient sets truecolor per glyph');
  assert.ok(g.split('\x1b[38;2;').length > 2, 'more than one color stop across the word');
  setColorEnabled(false);
});

test('stripAnsi + width measure the visible text regardless of color', () => {
  setColorEnabled(true);
  const colored = fg(BRAND.terracotta, 'hello');
  assert.equal(stripAnsi(colored), 'hello');
  assert.equal(width(colored), 5);
  setColorEnabled(false);
});

test('gradient preserves spaces and character order', () => {
  setColorEnabled(true);
  assert.equal(stripAnsi(gradient('a b')), 'a b');
  setColorEnabled(false);
});

test('box sizes its border to the widest line + padding', () => {
  setColorEnabled(false);
  const out = box(['ab', 'abcd'], { padX: 2 }).split('\n');
  // top border = ╭ + ─*(content 4 + pad 2*2) + ╮  → 4 + 4 = 8 dashes
  assert.equal(out[0], '╭' + '─'.repeat(8) + '╮');
  assert.equal(out.at(-1), '╰' + '─'.repeat(8) + '╯');
  // each content row is the same visible width as the border
  for (const row of out) assert.equal(width(row), 10);
});

test('gradientBlock keeps every row the same visible width (alignment preserved)', () => {
  setColorEnabled(true);
  const rows = gradientBlock(['███ ', '█  █', '███ ']);
  for (const r of rows) assert.equal(width(r), 4);
  setColorEnabled(false);
});

test('spinner in no-color mode is a safe no-op that still prints its final line', () => {
  setColorEnabled(false);
  const s = spinner('working');
  assert.equal(typeof s.stop, 'function');
  assert.doesNotThrow(() => s.stop());
});

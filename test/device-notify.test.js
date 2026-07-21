// ABOUTME: The per-OS native-notification command builder — pure, so we test the exact command without
// ABOUTME: spawning anything. Delivery (showDeviceNotification) shells out to these; never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyCommand, showDeviceNotification } from '../src/connect/device-notify.js';

test('notifyCommand builds the right per-OS command', () => {
  const mac = notifyCommand('darwin', { title: 'GFA-1 assigned to you', body: 'Fix the bug' });
  assert.equal(mac.cmd, 'osascript');
  assert.ok(mac.args.join(' ').includes('display notification'));
  assert.ok(mac.args.join(' ').includes('GFA-1 assigned to you'));

  const linux = notifyCommand('linux', { title: 'T', body: 'B' });
  assert.equal(linux.cmd, 'notify-send');
  assert.deepEqual(linux.args, ['T', 'B']);

  const win = notifyCommand('win32', { title: 'T', body: 'B' });
  assert.equal(win.cmd, 'powershell');

  assert.equal(notifyCommand('sunos', { title: 'T' }), null);
});

test('notifyCommand escapes quotes so a crafted title cannot break out', () => {
  const c = notifyCommand('darwin', { title: 'a"b', body: 'c"d' });
  // JSON-quoted → the inner quote is escaped, not a raw string terminator
  assert.ok(c.args[1].includes('\\"'));
});

test('showDeviceNotification runs the command via an injected spawn and never throws', () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => { calls.push({ cmd, args }); return { on() {} }; };
  const ok = showDeviceNotification({ title: 'T', body: 'B' }, { platform: 'linux', spawn: fakeSpawn });
  assert.equal(ok, true);
  assert.equal(calls[0].cmd, 'notify-send');
  // unknown platform → no spawn, returns false, no throw
  assert.equal(showDeviceNotification({ title: 'T' }, { platform: 'plan9', spawn: fakeSpawn }), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  serviceEnvPath,
  servicePaths,
  isRemovablePath,
  SERVICE_LABEL,
} from '../src/connect/service.js';

// The pure scaffolding behind `be10x service install` — the launchd plist / systemd unit / PATH builders.
// bin/be10x.js runs launchctl/systemctl around these; here we lock the file contents.

test('buildLaunchdPlist runs `node <cli> connect` at load, keeps it alive, and bakes the PATH', () => {
  const plist = buildLaunchdPlist({
    node: '/usr/bin/node',
    cli: '/opt/be10x/bin/be10x.js',
    home: '/Users/x',
    logPath: '/Users/x/.be10x/connect.log',
    path: '/usr/bin:/bin',
  });
  assert.match(plist, /<string>com\.be10x\.connect<\/string>/);
  assert.match(plist, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/opt\/be10x\/bin\/be10x\.js<\/string>/);
  assert.match(plist, /<string>connect<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin<\/string>/);
  assert.match(plist, /connect\.log/);
});

test('buildSystemdUnit runs connect, restarts always, and installs to the default target', () => {
  const unit = buildSystemdUnit({ node: '/usr/bin/node', cli: '/opt/be10x/bin/be10x.js', path: '/usr/bin:/bin' });
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/be10x\/bin\/be10x\.js connect/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /Environment=PATH=\/usr\/bin:\/bin/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('serviceEnvPath prepends the node dir and dedupes, order-preserving', () => {
  assert.equal(serviceEnvPath('/n/bin', '/usr/bin:/bin'), '/n/bin:/usr/bin:/bin');
  assert.equal(serviceEnvPath('/usr/bin', '/usr/bin:/bin'), '/usr/bin:/bin', 'node dir already present is not duplicated');
  assert.equal(serviceEnvPath('/n/bin', ''), '/n/bin');
});

test('servicePaths puts files where launchd/systemd expect them', () => {
  const p = servicePaths('/Users/x');
  assert.equal(p.label, SERVICE_LABEL);
  assert.equal(p.plistPath, '/Users/x/Library/LaunchAgents/com.be10x.connect.plist');
  assert.equal(p.systemdPath, '/Users/x/.config/systemd/user/be10x-connect.service');
  assert.equal(p.logPath, '/Users/x/.be10x/connect.log');
});

test('isRemovablePath flags volume mounts (boot-unsafe) but not stable paths', () => {
  assert.equal(isRemovablePath('/Volumes/X9/repo/bin/be10x.js'), true);
  assert.equal(isRemovablePath('/media/usb/be10x.js'), true);
  assert.equal(isRemovablePath('/Users/x/.nvm/versions/node/v22/lib/node_modules/be10x/bin/be10x.js'), false);
});

test('plist XML-escapes special characters in baked values', () => {
  const plist = buildLaunchdPlist({
    node: '/n',
    cli: '/c',
    home: '/h',
    logPath: '/l',
    path: '/a&b:/c<d',
  });
  assert.match(plist, /\/a&amp;b:\/c&lt;d/);
  assert.doesNotMatch(plist, /\/a&b:/, 'raw ampersand must be escaped');
});

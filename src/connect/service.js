// ABOUTME: Background-service scaffolding for `be10x connect` — turn the connector into an always-on daemon
// ABOUTME: that auto-starts on login/boot and restarts on crash. macOS launchd + Linux systemd --user builders.
//
// Pure strings/paths here (unit-tested); bin/be10x.js does the launchctl/systemctl side effects around them.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SERVICE_LABEL = 'com.be10x.connect';
export const SYSTEMD_UNIT = 'be10x-connect.service';

export function servicePaths(home = homedir()) {
  return {
    label: SERVICE_LABEL,
    unit: SYSTEMD_UNIT,
    logPath: join(home, '.be10x', 'connect.log'),
    plistPath: join(home, 'Library', 'LaunchAgents', SERVICE_LABEL + '.plist'),
    systemdPath: join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT),
  };
}

// XML-escape a value going into a plist <string>.
function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A macOS LaunchAgent that runs `node <cli> connect` in the background, at login, restarting on crash.
// `path` is baked into the service env so the connector (and the claude it spawns) find node, claude, and
// git — launchd otherwise runs with a minimal PATH and the agent's tools would be missing.
export function buildLaunchdPlist({ label = SERVICE_LABEL, node, cli, home, logPath, path }) {
  const args = [node, cli, 'connect'].map((a) => '        <string>' + xml(a) + '</string>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>WorkingDirectory</key>
    <string>${xml(home)}</string>
    <key>StandardOutPath</key>
    <string>${xml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${xml(home)}</string>
        <key>PATH</key>
        <string>${xml(path)}</string>
    </dict>
</dict>
</plist>
`;
}

// The Linux equivalent: a systemd --user service. `systemctl --user enable --now` + `loginctl enable-linger`
// (done in the CLI) make it start at boot and survive logout.
export function buildSystemdUnit({ node, cli, path }) {
  return `[Unit]
Description=be10x connect — background agent runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${node} ${cli} connect
Restart=always
RestartSec=5
Environment=PATH=${path}

[Install]
WantedBy=default.target
`;
}

// The PATH to bake into the service: the caller's current PATH (which has node/claude/git if `be10x connect`
// worked interactively) with the node binary's own dir prepended, deduped in order.
export function serviceEnvPath(nodeDir, currentPath = '') {
  const seen = new Set();
  const out = [];
  for (const p of [nodeDir, ...String(currentPath).split(':')].map((s) => s.trim())) {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out.join(':');
}

// A CLI path living on a removable/volume mount won't be there early at boot — warn so the user installs the
// service from a stable (global) install instead. Best-effort heuristic across macOS/Linux mount points.
export function isRemovablePath(p) {
  return /^\/(Volumes|media|mnt)\//.test(String(p || ''));
}

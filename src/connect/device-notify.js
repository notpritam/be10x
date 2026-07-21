// ABOUTME: Native OS notifications for the connector — dependency-free (shells out to the platform's own
// ABOUTME: notifier). `notifyCommand` is pure (the exact command); `showDeviceNotification` runs it, never throws.
import { spawn as realSpawn } from 'node:child_process';

// Build the platform's notification command. Titles/bodies are JSON-quoted so a crafted string can't break
// out of the argument. Returns { cmd, args } or null for an unsupported platform.
export function notifyCommand(platform, { title, body = '' } = {}) {
  const t = String(title ?? '');
  const b = String(body ?? '');
  if (platform === 'darwin') {
    // AppleScript strings are double-quoted; JSON.stringify yields exactly that, with quotes escaped.
    return { cmd: 'osascript', args: ['-e', `display notification ${JSON.stringify(b)} with title ${JSON.stringify(t)}`] };
  }
  if (platform === 'linux') {
    return { cmd: 'notify-send', args: [t, b] };
  }
  if (platform === 'win32') {
    // A dependency-free balloon tip via the built-in Windows Forms notifier.
    const ps =
      "[reflection.assembly]::loadwithpartialname('System.Windows.Forms')|Out-Null;" +
      '$n=New-Object System.Windows.Forms.NotifyIcon;' +
      '$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;' +
      `$n.ShowBalloonTip(5000, ${JSON.stringify(t)}, ${JSON.stringify(b)}, 'Info')`;
    return { cmd: 'powershell', args: ['-NoProfile', '-Command', ps] };
  }
  return null;
}

// Fire a native notification. Best-effort: an unsupported platform or a missing notifier just returns false.
export function showDeviceNotification({ title, body } = {}, { platform = process.platform, spawn = realSpawn } = {}) {
  try {
    const c = notifyCommand(platform, { title, body });
    if (!c) return false;
    const child = spawn(c.cmd, c.args, { stdio: 'ignore' });
    if (child && typeof child.on === 'function') child.on('error', () => {});
    return true;
  } catch {
    return false;
  }
}

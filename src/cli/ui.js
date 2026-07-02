// ABOUTME: Dependency-free ANSI toolkit for the be10x CLI — truecolor gradients, rounded boxes, spinners,
// ABOUTME: brand palette, symbols. TTY/NO_COLOR aware: degrades to clean plain text when piped or in CI.
//
// Zero dependencies (raw escape codes) so the CLI stays install-in-one-command with no native build. Color
// is a single toggle (`enabled`): off when stdout isn't a TTY, when NO_COLOR is set, or when tests force it —
// so a launchd/systemd service logging to a file never gets escape codes, and pipes stay clean.

const ESC = '\x1b[';

let enabled = computeEnabled();
function computeEnabled() {
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if ('NO_COLOR' in process.env && process.env.NO_COLOR !== '') return false;
  return !!(process.stdout && process.stdout.isTTY);
}
// Tests (and `--no-color`) flip this deterministically.
export function setColorEnabled(v) { enabled = !!v; }
export function colorEnabled() { return enabled; }

// Brand palette. teal = durable state (the board), terracotta = the agent/work, amber bridges them.
export const BRAND = {
  teal: [45, 212, 191],
  sky: [56, 189, 248],
  amber: [232, 179, 92],
  terracotta: [224, 122, 95],
  slate: [148, 163, 184],
  slateDim: [100, 116, 139],
  good: [52, 211, 153],
  warn: [232, 179, 92],
  bad: [248, 113, 113],
};

export function fg(rgb, s) {
  return enabled ? `${ESC}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}${ESC}39m` : String(s);
}
export function bold(s) { return enabled ? `${ESC}1m${s}${ESC}22m` : String(s); }
export function dim(s) { return enabled ? `${ESC}2m${s}${ESC}22m` : String(s); }
export function italic(s) { return enabled ? `${ESC}3m${s}${ESC}23m` : String(s); }

export function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }
export function width(s) { return stripAnsi(s).length; }

const lerp = (a, b, t) => Math.round(a + (b - a) * t);
function sampleStops(stops, t) {
  if (t <= 0) return stops[0];
  if (t >= 1) return stops[stops.length - 1];
  const seg = t * (stops.length - 1);
  const i = Math.floor(seg);
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

// Horizontal gradient across the visible characters of a single line.
export function gradient(text, stops = [BRAND.teal, BRAND.terracotta]) {
  const s = String(text);
  if (!enabled) return s;
  const n = Math.max(s.length - 1, 1);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') { out += ' '; continue; }
    const [r, g, b] = sampleStops(stops, i / n);
    out += `${ESC}38;2;${r};${g};${b}m${s[i]}`;
  }
  return out + `${ESC}39m`;
}

// Gradient a block of lines by COLUMN, so a multi-row wordmark shades left→right uniformly across all rows.
export function gradientBlock(lines, stops = [BRAND.teal, BRAND.amber, BRAND.terracotta]) {
  const w = Math.max(...lines.map((l) => l.length), 1);
  return lines.map((line) => {
    if (!enabled) return line;
    let out = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ' ') { out += ' '; continue; }
      const [r, g, b] = sampleStops(stops, i / (w - 1 || 1));
      out += `${ESC}38;2;${r};${g};${b}m${line[i]}`;
    }
    return out + `${ESC}39m`;
  });
}

export const sym = {
  get ok() { return fg(BRAND.good, '✓'); },
  get bad() { return fg(BRAND.bad, '✗'); },
  get dot() { return '●'; },
  get arrow() { return '▸'; },
  get bullet() { return '•'; },
};

// A rounded box around body lines. Sizes to the widest visible line; pads with `padX` on each side.
export function box(lines, { padX = 2, color = BRAND.slateDim } = {}) {
  const content = Math.max(...lines.map((l) => width(l)), 0);
  const innerBar = content + padX * 2;
  const side = fg(color, '│');
  const pad = ' '.repeat(padX);
  const out = [fg(color, '╭' + '─'.repeat(innerBar) + '╮')];
  for (const l of lines) {
    const gap = content - width(l);
    out.push(side + pad + l + ' '.repeat(Math.max(gap, 0)) + pad + side);
  }
  out.push(fg(color, '╰' + '─'.repeat(innerBar) + '╯'));
  return out.join('\n');
}

export function rule(w = 52, color = BRAND.slateDim) { return fg(color, '─'.repeat(w)); }

// A minimal braille spinner (TTY only; a no-op that just prints when color is off). Returns { stop(finalLine) }.
export function spinner(text) {
  if (!enabled) {
    process.stdout.write(text + '\n');
    return { stop: (final) => { if (final) process.stdout.write(final + '\n'); } };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  process.stdout.write('\x1b[?25l');
  const timer = setInterval(() => {
    process.stdout.write('\r' + fg(BRAND.teal, frames[i++ % frames.length]) + ' ' + text + '\x1b[K');
  }, 80);
  return {
    stop(final) {
      clearInterval(timer);
      process.stdout.write('\r\x1b[K\x1b[?25h');
      if (final) process.stdout.write(final + '\n');
    },
  };
}

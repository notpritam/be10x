// ABOUTME: The be10x CLI welcome/status screen — a gradient wordmark, a live status box (are you signed in?
// ABOUTME: which board? is the agent running?), and a grouped command menu. Rendered on a bare `be10x`.
//
// Pure: renderWelcome(state) takes a plain state object and returns a string, so it's unit-testable and the
// bin layer owns gathering state (connect.json, service status, versions).
import { BRAND, gradientBlock, box, fg, bold, dim, sym } from './ui.js';

// A 5-row block wordmark. Each glyph is 5 columns wide; rows are joined with a single-space gutter so the
// column gradient reads cleanly across the whole word.
const GLYPHS = {
  B: ['████ ', '█   █', '████ ', '█   █', '████ '],
  E: ['█████', '█    ', '███  ', '█    ', '█████'],
  1: ['  █  ', ' ██  ', '  █  ', '  █  ', ' ███ '],
  0: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  X: ['█   █', ' █ █ ', '  █  ', ' █ █ ', '█   █'],
};

export function wordmark(word = 'BE10X') {
  return [0, 1, 2, 3, 4].map((r) => [...word].map((c) => GLYPHS[c][r]).join(' '));
}

function indent(s, n = 2) {
  const p = ' '.repeat(n);
  return s
    .split('\n')
    .map((l) => p + l)
    .join('\n');
}

// The gradient wordmark + tagline — reused as a header by other commands (login, service).
export function renderBrand() {
  const mark = gradientBlock(wordmark()).join('\n');
  return indent(mark) + '\n' + '  ' + dim('human + agent task board  ·  sessions disposable, state durable');
}

// state: { user, board, service: 'running'|'stopped'|'none', repos: string[], version, latest }
export function renderWelcome(state = {}) {
  const { user = null, board = null, service = 'none', repos = [], version = '', latest = null, signedIn = false } = state;

  const kv = (label, value) => fg(BRAND.slate, label.padEnd(8)) + value;
  const account = user
    ? fg(BRAND.teal, user)
    : signedIn
      ? fg(BRAND.teal, 'signed in')
      : dim('not signed in  ·  be10x login <board>');
  const agent =
    service === 'running'
      ? fg(BRAND.good, '● ') + 'running' + (repos.length ? dim(`  ·  ${repos.length} repo${repos.length > 1 ? 's' : ''}`) : '')
      : service === 'stopped'
        ? fg(BRAND.warn, '● ') + 'installed, not running' + dim('  ·  be10x service status')
        : dim('○ ') + dim('not a service  ·  be10x service install');

  const status = box([
    kv('account', account),
    kv('board', board ? board : dim('none linked')),
    kv('agent', agent),
  ]);

  const cmd = (name, desc) => '    ' + fg(BRAND.teal, sym.arrow + ' ' + name.padEnd(8)) + dim(desc);
  const menu = [
    '  ' + bold('Get started'),
    cmd('login', 'sign in to a board (opens your browser)'),
    cmd('link', 'register the current repo with the board'),
    cmd('service', 'run the agent always-on in the background'),
    '',
    '  ' + bold('Manage'),
    cmd('connect', 'run the agent here in the foreground'),
    cmd('list', "projects & this repo's tasks"),
    cmd('update', 'update be10x to the latest version'),
  ].join('\n');

  const updateNote =
    latest && version && latest !== version ? '  ' + fg(BRAND.amber, `↑ update available (v${latest}) — run: be10x update`) : '';
  const footer = '  ' + dim(`v${version || '?'}  ·  be10x <command> --help`);

  const parts = ['', renderBrand(), '', indent(status), '', menu, ''];
  if (updateNote) parts.push(updateNote);
  parts.push(footer, '');
  return parts.join('\n');
}

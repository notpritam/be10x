// ABOUTME: In-page recorder widget — a floating, themed, accessible control mounted in a Shadow DOM root
// ABOUTME: (host wears BLOCK_CLASS so rrweb never records it). Start/Stop, Mark, live indicator, Report form.
import { BLOCK_CLASS } from './recorder';
import { describeElement } from './element-pick';
import type { PickedElement } from './protocol';

export type ReportForm = {
  title: string;
  severity: string;
  description: string;
  notes: string; // composed QA notes (freeform + expected/actual); '' when the drawer was left empty
  pickedElements: PickedElement[]; // elements the QA pinpointed with the picker; [] when none
  teamId?: string | null; // triage routing chosen in the pickers — null when left unset
  projectId?: string | null;
  tags?: string[]; // freeform labels; [] when none
};

// A team or project the bug can be routed to — the minimal shape the pickers need.
export type Taxon = { id: string; name: string };

// Split a comma/newline-separated tag field into clean labels (trimmed, de-duped, capped, <=40 chars each).
function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const t = part.trim().slice(0, 40);
    if (t) seen.add(t);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

// Fold the notes drawer's fields into one string for meta.notes / description seeding.
function composeNotes(text: string, expected: string, actual: string): string {
  const parts: string[] = [];
  if (text.trim()) parts.push(text.trim());
  if (expected.trim()) parts.push('Expected: ' + expected.trim());
  if (actual.trim()) parts.push('Actual: ' + actual.trim());
  return parts.join('\n\n');
}

export type WidgetCallbacks = {
  isRecording: () => boolean; // an explicit take is in progress
  explicitStartedAt: () => number | null; // epoch ms, for the elapsed clock
  onStart: () => void;
  onStop: () => void;
  onMark: (label?: string) => void;
  onReport: (form: ReportForm) => Promise<{ ok: boolean; message: string }>;
  loadTaxonomy?: () => Promise<{ teams: Taxon[]; projects: Taxon[] }>; // teams/projects for the pickers
};

const HOST_ID = 'be10x-recorder-widget';

// Small hyperscript helper — keeps the DOM construction readable without a framework in every page.
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
// A 24×24 line icon (lucide-style: currentColor stroke, no fill) from child shape specs. `fill` swaps to a
// solid glyph (record/stop). Returned as a Node so it drops straight into an h(...) child list. Clean,
// minimal, monochrome — inherits the button's color, so hover/active/dark-mode all just work.
function icon(shapes: [string, Record<string, string>][], fill = false): SVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', fill ? 'currentColor' : 'none');
  el.setAttribute('stroke', fill ? 'none' : 'currentColor');
  el.setAttribute('stroke-width', '2');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of shapes) {
    const s = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    el.append(s);
  }
  return el;
}

const ICONS = {
  bug: (): SVGElement =>
    icon([
      ['rect', { x: '8', y: '7', width: '8', height: '11', rx: '4' }],
      ['line', { x1: '8', y1: '11', x2: '4', y2: '9' }],
      ['line', { x1: '8', y1: '14', x2: '3.5', y2: '14' }],
      ['line', { x1: '8', y1: '17', x2: '5', y2: '20' }],
      ['line', { x1: '16', y1: '11', x2: '20', y2: '9' }],
      ['line', { x1: '16', y1: '14', x2: '20.5', y2: '14' }],
      ['line', { x1: '16', y1: '17', x2: '19', y2: '20' }],
      ['line', { x1: '10', y1: '7', x2: '9', y2: '3.5' }],
      ['line', { x1: '14', y1: '7', x2: '15', y2: '3.5' }],
    ]),
  crosshair: (): SVGElement =>
    icon([
      ['circle', { cx: '12', cy: '12', r: '9' }],
      ['line', { x1: '12', y1: '2.5', x2: '12', y2: '6.5' }],
      ['line', { x1: '12', y1: '17.5', x2: '12', y2: '21.5' }],
      ['line', { x1: '2.5', y1: '12', x2: '6.5', y2: '12' }],
      ['line', { x1: '17.5', y1: '12', x2: '21.5', y2: '12' }],
    ]),
  note: (): SVGElement =>
    icon([
      ['path', { d: 'M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }],
      ['path', { d: 'M14 3v6h6' }],
      ['line', { x1: '8.5', y1: '13', x2: '15', y2: '13' }],
      ['line', { x1: '8.5', y1: '16.5', x2: '13', y2: '16.5' }],
    ]),
  flag: (): SVGElement =>
    icon([
      ['path', { d: 'M5 21V4' }],
      ['path', { d: 'M5 4h11l-2 3.5L16 11H5' }],
    ]),
  record: (): SVGElement => icon([['circle', { cx: '12', cy: '12', r: '6' }]], true),
  stop: (): SVGElement => icon([['rect', { x: '7', y: '7', width: '10', height: '10', rx: '2' }]], true),
  chevronDown: (): SVGElement => icon([['path', { d: 'M6 9l6 6 6-6' }]]),
};

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .root {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    font: 13px/1.4 -apple-system, system-ui, "Segoe UI", sans-serif;
    color: #17171a;
  }
  .bubble {
    width: 44px; height: 44px; border-radius: 50%; border: 0; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    background: #2563eb; color: #fff;
    box-shadow: 0 6px 20px rgba(0,0,0,.28); transition: transform .12s ease;
  }
  .bubble svg { width: 22px; height: 22px; }
  .bubble:hover { transform: translateY(-1px); }
  .bubble.rec { background: #c0392b; animation: pulse 1.4s ease-in-out infinite; }
  .card {
    width: 288px; background: #fff; border-radius: 12px; overflow: hidden;
    box-shadow: 0 10px 34px rgba(0,0,0,.26); border: 1px solid rgba(0,0,0,.08);
  }
  .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(0,0,0,.07); }
  .stat { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0; font-weight: 600; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #e0a800; flex: none; }
  .dot.on { background: #c0392b; animation: pulse 1.4s ease-in-out infinite; }
  .stat-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-weight: 400; font-variant-numeric: tabular-nums; opacity: .6; }
  .icon { border: 0; background: transparent; cursor: pointer; color: inherit; opacity: .5; padding: 5px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; }
  .icon:hover { opacity: 1; background: rgba(0,0,0,.06); }
  .icon svg { width: 16px; height: 16px; }
  .body { padding: 12px; display: grid; gap: 10px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .btn { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); background: #f5f5f7; color: #17171a; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .btn svg { width: 14px; height: 14px; }
  .btn:hover { background: #ececef; }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { background: #2563eb; color: #fff; border-color: transparent; }
  .btn.primary:hover { background: #1d4ed8; }
  .btn.rec.on { background: #c0392b; color: #fff; border-color: transparent; }
  .field { display: grid; gap: 4px; }
  .field > span { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; opacity: .55; }
  input, select, textarea { width: 100%; padding: 7px 9px; border: 1px solid #d3d3d8; border-radius: 8px; font: inherit; background: #fff; color: #17171a; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: #2563eb; }
  textarea { resize: vertical; min-height: 54px; }
  .msg { font-size: 12px; min-height: 0; }
  .msg.err { color: #c0392b; }
  .msg.ok { color: #1a7f37; }
  .hidden { display: none !important; }
  .icon.notes-toggle { position: relative; }
  .icon.notes-toggle.has-notes { opacity: 1; color: #2563eb; }
  .icon.notes-toggle.has-notes::after {
    content: ''; position: absolute; top: 2px; right: 2px; width: 6px; height: 6px; border-radius: 50%; background: #2563eb;
  }
  .drawer {
    overflow: hidden; display: grid; gap: 10px; padding: 0 12px; max-height: 0; opacity: 0; visibility: hidden;
    border-bottom: 1px solid transparent;
    transition: max-height .18s ease, opacity .18s ease, padding .18s ease, visibility 0s linear .18s;
  }
  .drawer.open {
    max-height: 380px; opacity: 1; visibility: visible; padding: 12px; border-color: rgba(0,0,0,.07);
    transition: max-height .18s ease, opacity .18s ease, padding .18s ease, visibility 0s;
  }
  .drawer-hint { font-size: 11px; opacity: .55; margin: -2px 0 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .icon.pick-toggle.active { opacity: 1; color: #2563eb; }
  .pick-outline {
    position: fixed; top: 0; left: 0; z-index: 2147483646; pointer-events: none; box-sizing: border-box;
    border: 2px solid #2563eb; background: rgba(37,99,235,.12); border-radius: 3px; display: none;
  }
  .pick-outline.on { display: block; }
  .pick-label {
    position: fixed; top: 0; left: 0; z-index: 2147483647; pointer-events: none; display: none;
    font: 11px/1.4 -apple-system, system-ui, sans-serif; background: #2563eb; color: #fff;
    padding: 2px 6px; border-radius: 4px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis;
  }
  .pick-label.on { display: block; }
  .pick-banner {
    position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483647; display: none;
    align-items: center; gap: 10px; background: #17171a; color: #fff; border-radius: 999px;
    padding: 7px 8px 7px 14px; box-shadow: 0 8px 24px rgba(0,0,0,.32);
    font: 12px/1.4 -apple-system, system-ui, sans-serif;
  }
  .pick-banner.on { display: flex; }
  .pick-banner .lead { display: inline-flex; align-items: center; gap: 7px; }
  .pick-banner svg { width: 15px; height: 15px; }
  .pick-banner .count { font-variant-numeric: tabular-nums; opacity: .7; }
  .rec-icon { display: inline-flex; align-items: center; }
  .btn.rec.on .rec-icon { color: #fff; }
  .pill-btn {
    border: 0; cursor: pointer; border-radius: 999px; padding: 4px 10px; font: inherit; font-weight: 600;
    background: rgba(255,255,255,.14); color: #fff;
  }
  .pill-btn:hover { background: rgba(255,255,255,.24); }
  .pill-btn:disabled { opacity: .45; cursor: default; }
  .pill-btn.primary { background: #2563eb; }
  .pill-btn.primary:hover { background: #1d4ed8; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  @media (prefers-color-scheme: dark) {
    .root { color: #ececee; }
    .card { background: #1f1f22; border-color: rgba(255,255,255,.08); }
    .hd { border-color: rgba(255,255,255,.08); }
    .icon:hover { background: rgba(255,255,255,.08); }
    .btn { background: #2c2c30; color: #ececee; border-color: rgba(255,255,255,.12); }
    .btn:hover { background: #34343a; }
    input, select, textarea { background: #2c2c30; color: #ececee; border-color: #3a3a40; }
    .drawer.open { border-color: rgba(255,255,255,.08); }
  }
`;

// Mount the widget once. Returns a destroy() that tears down DOM + timers + listeners.
export function mountWidget(cb: WidgetCallbacks): { destroy: () => void } {
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove(); // defensive against a double-mount (e.g. HMR)

  const host = h('div', { id: HOST_ID, class: BLOCK_CLASS, 'aria-hidden': 'false' });
  host.style.setProperty('all', 'initial');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(h('style', {}, CSS));

  const root = h('div', { class: 'root', role: 'region', 'aria-label': 'be10x bug recorder' });

  // Collapsed affordance
  const bubble = h('button', { class: 'bubble', type: 'button', 'aria-label': 'Open be10x bug recorder', title: 'be10x bug recorder' }, ICONS.bug());

  // Expanded card
  const dot = h('span', { class: 'dot' });
  const statText = h('span', { class: 'stat-text' }, 'Ready');
  const sub = h('span', { class: 'sub' });
  const stat = h('span', { class: 'stat' }, dot, statText, sub);
  const pickBtn = h('button', { class: 'icon pick-toggle', type: 'button', 'aria-label': 'Pick element', 'aria-pressed': 'false', title: 'Pick element' }, ICONS.crosshair());
  const notesBtn = h('button', { class: 'icon notes-toggle', type: 'button', 'aria-label': 'QA notes', 'aria-expanded': 'false', title: 'QA notes' }, ICONS.note());
  const collapseBtn = h('button', { class: 'icon', type: 'button', 'aria-label': 'Collapse recorder', title: 'Collapse' }, ICONS.chevronDown());
  const hd = h('div', { class: 'hd' }, stat, pickBtn, notesBtn, collapseBtn);

  // Record button: a swappable icon + a text label kept in its own span so the recording-state update can
  // retitle it without clobbering the icon.
  const recIconWrap = h('span', { class: 'rec-icon' }, ICONS.record());
  const recLabel = h('span', {}, 'Start');
  const recBtn = h('button', { class: 'btn rec', type: 'button' }, recIconWrap, recLabel);
  const markBtn = h('button', { class: 'btn', type: 'button', 'aria-label': 'Mark the bug moment' }, ICONS.flag(), h('span', {}, 'Mark'));
  const reportBtn = h('button', { class: 'btn primary', type: 'button' }, 'Report');
  const actions = h('div', { class: 'row' }, recBtn, markBtn, reportBtn);

  // Optional mark-label row
  const markInput = h('input', { class: 'mark-input', type: 'text', 'aria-label': 'Marker label', placeholder: 'This is the bug' });
  const markConfirm = h('button', { class: 'btn primary', type: 'button', 'aria-label': 'Place marker' }, ICONS.flag());
  const markRow = h('div', { class: 'row hidden' }, markInput, markConfirm);

  // Report form
  const fTitle = h('input', { class: 'f-title', type: 'text', placeholder: 'e.g. Pay button does nothing', required: 'true' });
  const fSev = h('select', { class: 'f-sev', 'aria-label': 'Severity' });
  for (const [v, label] of [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['critical', 'critical']]) {
    const opt = h('option', { value: v }, label);
    if (v === 'medium') opt.setAttribute('selected', 'true');
    fSev.append(opt);
  }
  const fDesc = h('textarea', { class: 'f-desc', placeholder: 'What happened? Steps, expected vs actual…' });
  // Triage routing — team/project selects are filled from the board on first open (loadTaxonomyOnce); a
  // board with no teams/projects just keeps the "none" option. Tags are freeform, comma-separated.
  const fTeam = h('select', { class: 'f-team', 'aria-label': 'Team' }, h('option', { value: '' }, '— No team —'));
  const fProject = h('select', { class: 'f-project', 'aria-label': 'Project' }, h('option', { value: '' }, '— No project —'));
  const fTags = h('input', { class: 'f-tags', type: 'text', placeholder: 'e.g. checkout, billing' });
  const cancelBtn = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Send report');
  const msg = h('div', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  const form = h(
    'form',
    { class: 'form hidden' },
    h('label', { class: 'field' }, h('span', {}, 'Title'), fTitle),
    h('label', { class: 'field' }, h('span', {}, 'Severity'), fSev),
    h(
      'div',
      { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'Team'), fTeam),
      h('label', { class: 'field' }, h('span', {}, 'Project'), fProject),
    ),
    h('label', { class: 'field' }, h('span', {}, 'Tags'), fTags),
    h('label', { class: 'field' }, h('span', {}, 'Description'), fDesc),
    h('div', { class: 'row' }, cancelBtn, submitBtn),
    msg,
  );

  // QA notes drawer — filled WHILE investigating, persists across the session, rides in meta.notes.
  const nText = h('textarea', { class: 'n-text', 'aria-label': 'QA notes', placeholder: 'What are you seeing? Steps, observations…' });
  const nExpected = h('input', { class: 'n-expected', type: 'text', 'aria-label': 'Expected result', placeholder: 'e.g. Payment succeeds' });
  const nActual = h('input', { class: 'n-actual', type: 'text', 'aria-label': 'Actual result', placeholder: 'e.g. Spinner hangs' });
  const notesPanel = h(
    'div',
    { class: 'drawer', role: 'group', 'aria-label': 'QA notes', 'aria-hidden': 'true' },
    h('label', { class: 'field' }, h('span', {}, 'Notes'), nText),
    h('p', { class: 'drawer-hint' }, 'Saved with the report. Seeds the description if you leave it blank.'),
    h(
      'div',
      { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'Expected'), nExpected),
      h('label', { class: 'field' }, h('span', {}, 'Actual'), nActual),
    ),
  );

  const body = h('div', { class: 'body' }, actions, markRow, form);
  const card = h('div', { class: 'card hidden' }, hd, notesPanel, body);
  root.append(bubble, card);
  shadow.append(root);

  // Element-picker overlay — a highlight outline + label that follow the hovered element, plus a control
  // banner. All in the Shadow DOM under BLOCK_CLASS, so rrweb never records the highlight or the toolbar.
  const pickOutline = h('div', { class: 'pick-outline', 'aria-hidden': 'true' });
  const pickLabel = h('div', { class: 'pick-label', 'aria-hidden': 'true' });
  const pickCount = h('span', { class: 'count' }, '0 picked');
  const pickClearBtn = h('button', { class: 'pill-btn', type: 'button' }, 'Clear');
  const pickDoneBtn = h('button', { class: 'pill-btn primary', type: 'button' }, 'Done');
  const pickBanner = h(
    'div',
    { class: 'pick-banner', role: 'region', 'aria-label': 'Element picker' },
    h('span', { class: 'lead' }, ICONS.crosshair(), h('span', {}, 'Click elements · Esc to exit')),
    pickCount,
    pickClearBtn,
    pickDoneBtn,
  );
  shadow.append(pickOutline, pickLabel, pickBanner);
  document.documentElement.append(host);

  // --- state ---
  let collapsed = false;
  let markOpen = false;
  let formOpen = false;
  let notesOpen = false;
  let busy = false;
  let pickMode = false;
  let pickedElements: PickedElement[] = [];
  let collapsedBeforePick = false;

  const hasNotes = () => !!(nText.value.trim() || nExpected.value.trim() || nActual.value.trim());

  const setMsg = (text: string, kind?: 'err' | 'ok') => {
    msg.textContent = text;
    msg.className = 'msg' + (kind ? ' ' + kind : '');
  };

  function render() {
    // In pick mode the card + bubble tuck away; the picker banner + overlay drive the session.
    bubble.classList.toggle('hidden', !collapsed || pickMode);
    card.classList.toggle('hidden', collapsed);
    bubble.classList.toggle('rec', cb.isRecording());
    markRow.classList.toggle('hidden', !markOpen);
    form.classList.toggle('hidden', !formOpen);
    actions.classList.toggle('hidden', formOpen);
    notesPanel.classList.toggle('open', notesOpen);
    notesPanel.setAttribute('aria-hidden', notesOpen ? 'false' : 'true');
    notesBtn.setAttribute('aria-expanded', notesOpen ? 'true' : 'false');
    notesBtn.classList.toggle('has-notes', hasNotes());
    pickBtn.classList.toggle('active', pickMode);
    pickBtn.setAttribute('aria-pressed', pickMode ? 'true' : 'false');
    pickBanner.classList.toggle('on', pickMode);
    pickCount.textContent = `${pickedElements.length} picked`;
    pickClearBtn.disabled = pickedElements.length === 0;

    const recording = cb.isRecording();
    recLabel.textContent = recording ? 'Stop' : 'Start';
    recIconWrap.replaceChildren(recording ? ICONS.stop() : ICONS.record());
    recBtn.classList.toggle('on', recording);
    dot.classList.toggle('on', recording);

    if (recording) {
      statText.textContent = 'Recording';
      const startedAt = cb.explicitStartedAt();
      sub.textContent = startedAt ? fmtElapsed(Date.now() - startedAt) : '';
    } else {
      statText.textContent = 'Buffering';
      sub.textContent = 'last 2 min';
    }
    reportBtn.disabled = busy;
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? 'Sending…' : 'Send report';
  }

  // Live tick so the elapsed clock + rolling/explicit state stay current.
  const timer = window.setInterval(render, 1000);

  // --- interactions ---
  bubble.addEventListener('click', () => {
    collapsed = false;
    render();
  });
  collapseBtn.addEventListener('click', () => {
    collapsed = true;
    markOpen = false;
    formOpen = false;
    notesOpen = false;
    render();
  });

  notesBtn.addEventListener('click', () => {
    notesOpen = !notesOpen;
    if (notesOpen) {
      markOpen = false;
      formOpen = false;
    }
    render();
    if (notesOpen) nText.focus();
  });
  // Keep the header indicator live as the QA types, without waiting for the 1s render tick.
  for (const el of [nText, nExpected, nActual]) el.addEventListener('input', render);

  // --- element picker ---
  // True when the event target is our own widget (host, or anything inside its Shadow DOM) — those must
  // never be highlighted/captured, and their clicks (banner buttons) must pass through untouched.
  const isOwnTarget = (t: EventTarget | null): boolean => {
    if (!t || !(t instanceof Node)) return true;
    if (t === host) return true;
    try {
      if (t.getRootNode() === shadow) return true;
    } catch {
      /* ignore */
    }
    return false;
  };
  // The real page element under an event (composedPath pierces shadow), or null for our own UI.
  const pickTarget = (e: Event): Element | null => {
    try {
      const path = e.composedPath ? e.composedPath() : [];
      const t = (path.length ? path[0] : e.target) as EventTarget | null;
      if (isOwnTarget(t)) return null;
      return t instanceof Element ? t : null;
    } catch {
      return null;
    }
  };
  const hideOutline = () => {
    pickOutline.classList.remove('on');
    pickLabel.classList.remove('on');
  };
  const positionOutline = (el: Element) => {
    try {
      const r = el.getBoundingClientRect();
      pickOutline.style.left = r.left + 'px';
      pickOutline.style.top = r.top + 'px';
      pickOutline.style.width = r.width + 'px';
      pickOutline.style.height = r.height + 'px';
      pickOutline.classList.add('on');
      const cls = (el.getAttribute('class') || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((c) => '.' + c)
        .join('');
      pickLabel.textContent = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls} · ${Math.round(r.width)}×${Math.round(r.height)}`;
      pickLabel.style.left = Math.max(4, r.left) + 'px';
      pickLabel.style.top = (r.top - 20 < 4 ? r.top + 4 : r.top - 20) + 'px';
      pickLabel.classList.add('on');
    } catch {
      /* ignore */
    }
  };
  const onPickMove = (e: MouseEvent) => {
    const t = pickTarget(e);
    if (!t) {
      hideOutline();
      return;
    }
    positionOutline(t);
  };
  const onPickClick = (e: MouseEvent) => {
    const t = pickTarget(e);
    if (!t) return; // our own UI (banner buttons) — let them handle the click
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    try {
      if (pickedElements.length < 50) pickedElements.push({ ...describeElement(t), ts: Date.now() });
    } catch {
      /* ignore — never break the page over one bad element */
    }
    render();
  };
  // Shield the page from the picking interaction (focus, navigation, drag-start) — page targets only.
  const onPickShield = (e: Event) => {
    const t = pickTarget(e);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof (e as MouseEvent).stopImmediatePropagation === 'function') (e as MouseEvent).stopImmediatePropagation();
  };
  const onPickKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    exitPick();
  };
  const pickListeners: [string, EventListener][] = [
    ['mousemove', onPickMove as EventListener],
    ['click', onPickClick as EventListener],
    ['mousedown', onPickShield],
    ['mouseup', onPickShield],
    ['pointerdown', onPickShield],
    ['keydown', onPickKey as EventListener],
  ];
  const addPickListeners = () => {
    for (const [type, fn] of pickListeners) document.addEventListener(type, fn, true);
  };
  const removePickListeners = () => {
    for (const [type, fn] of pickListeners) {
      try {
        document.removeEventListener(type, fn, true);
      } catch {
        /* ignore */
      }
    }
  };
  function enterPick() {
    if (pickMode) return;
    pickMode = true;
    collapsedBeforePick = collapsed;
    collapsed = true; // tuck the card away — the banner + overlay drive the pick session
    markOpen = formOpen = notesOpen = false;
    addPickListeners();
    render();
  }
  function exitPick() {
    if (!pickMode) return;
    pickMode = false;
    removePickListeners();
    hideOutline();
    collapsed = collapsedBeforePick;
    render();
  }
  pickBtn.addEventListener('click', () => {
    if (pickMode) exitPick();
    else enterPick();
  });
  pickClearBtn.addEventListener('click', () => {
    pickedElements = [];
    render();
  });
  pickDoneBtn.addEventListener('click', exitPick);

  recBtn.addEventListener('click', () => {
    if (cb.isRecording()) cb.onStop();
    else cb.onStart();
    render();
  });

  markBtn.addEventListener('click', () => {
    markOpen = !markOpen;
    formOpen = false;
    notesOpen = false;
    render();
    if (markOpen) {
      markInput.value = 'This is the bug';
      markInput.focus();
      markInput.select();
    }
  });
  const placeMark = () => {
    cb.onMark(markInput.value);
    markOpen = false;
    render();
    setMsg('Marked ✓', 'ok');
    window.setTimeout(() => {
      if (!formOpen) setMsg('');
    }, 1500);
  };
  markConfirm.addEventListener('click', placeMark);
  markInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      placeMark();
    }
  });

  // Fill the team/project pickers from the board the first time the form opens. Best-effort — no callback,
  // a disconnected board, or a fetch error just leaves the "none" options (and lets the next open retry).
  let taxonomyLoaded = false;
  const loadTaxonomyOnce = () => {
    if (taxonomyLoaded || !cb.loadTaxonomy) return;
    taxonomyLoaded = true;
    cb.loadTaxonomy().then(
      ({ teams, projects }) => {
        for (const t of teams) fTeam.append(h('option', { value: t.id }, t.name));
        for (const p of projects) fProject.append(h('option', { value: p.id }, p.name));
      },
      () => {
        taxonomyLoaded = false;
      },
    );
  };
  reportBtn.addEventListener('click', () => {
    formOpen = true;
    markOpen = false;
    notesOpen = false;
    loadTaxonomyOnce();
    setMsg('');
    render();
    fTitle.focus();
  });
  cancelBtn.addEventListener('click', () => {
    formOpen = false;
    setMsg('');
    render();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    const title = fTitle.value.trim();
    if (!title) {
      setMsg('Add a short title first', 'err');
      fTitle.focus();
      return;
    }
    busy = true;
    setMsg('Capturing & uploading…');
    render();
    const notes = composeNotes(nText.value, nExpected.value, nActual.value);
    cb.onReport({
      title,
      severity: fSev.value,
      description: fDesc.value.trim(),
      notes,
      pickedElements: pickedElements.slice(),
      teamId: fTeam.value || null,
      projectId: fProject.value || null,
      tags: parseTags(fTags.value),
    })
      .then((r) => {
        busy = false;
        setMsg(r.message, r.ok ? 'ok' : 'err');
        if (r.ok) {
          fTitle.value = '';
          fDesc.value = '';
          fTags.value = ''; // tags are per-bug; team/project persist for filing a batch to the same place
          nText.value = '';
          nExpected.value = '';
          nActual.value = '';
          pickedElements = [];
          formOpen = false;
        }
        render();
      })
      .catch((err) => {
        busy = false;
        setMsg('Report failed: ' + String(err?.message || err), 'err');
        render();
      });
  });

  // Esc peels back one layer at a time; keeps the widget keyboard-dismissible.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (formOpen) formOpen = false;
    else if (markOpen) markOpen = false;
    else if (notesOpen) notesOpen = false;
    else if (!collapsed) collapsed = true;
    else return;
    e.stopPropagation();
    render();
  };
  root.addEventListener('keydown', onKey);

  render();

  return {
    destroy() {
      window.clearInterval(timer);
      root.removeEventListener('keydown', onKey);
      removePickListeners(); // no-op if pick mode was never entered
      host.remove();
    },
  };
}

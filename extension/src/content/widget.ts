// ABOUTME: In-page recorder widget — a floating, themed, accessible control mounted in a Shadow DOM root
// ABOUTME: (host wears BLOCK_CLASS so rrweb never records it). Start/Stop, Mark, live indicator, Report form.
import { BLOCK_CLASS } from './recorder';
import { describeElement } from './element-pick';
import type { DrawStroke, PickedElement, TestCredentials } from './protocol';

export type ReportForm = {
  title: string;
  severity: string;
  description: string;
  notes: string; // composed QA notes (freeform + expected/actual); '' when the drawer was left empty
  pickedElements: PickedElement[]; // elements the QA pinpointed with the picker; [] when none
  drawings: DrawStroke[]; // freehand annotations drawn over the page; [] when none
  credentials?: TestCredentials; // the login the reporter was testing with; omitted when blank
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
  onDiscard?: () => void; // drop the current take (recorder.reset) when the reporter discards after stopping
  loadTaxonomy?: () => Promise<{ teams: Taxon[]; projects: Taxon[] }>; // teams/projects for the pickers
  captureHealth?: () => Promise<CaptureHealth>; // what will be captured — surfaced in the report form
};

// A snapshot of what the current capture window holds, shown as a "capture health" line before filing so the
// reporter can see the recording is actually catching what they expect (network, console, errors).
export type CaptureHealth = { durationMs: number; network: number; console: number; errors: number };

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
  pen: (): SVGElement =>
    icon([
      ['path', { d: 'M12 20h9' }],
      ['path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' }],
    ]),
  key: (): SVGElement =>
    icon([
      ['circle', { cx: '7.5', cy: '15.5', r: '3.5' }],
      ['path', { d: 'M10 13l6.5-6.5' }],
      ['path', { d: 'M15 5l3 3' }],
      ['path', { d: 'M18.5 8.5l2-2' }],
    ]),
  eye: (): SVGElement =>
    icon([
      ['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z' }],
      ['circle', { cx: '12', cy: '12', r: '3' }],
    ]),
  eyeOff: (): SVGElement =>
    icon([
      ['path', { d: 'M9.9 5.2A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1' }],
      ['path', { d: 'M6.1 6.1A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4-.9' }],
      ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2' }],
      ['line', { x1: '3', y1: '3', x2: '21', y2: '21' }],
    ]),
  undo: (): SVGElement =>
    icon([
      ['path', { d: 'M9 14L4 9l5-5' }],
      ['path', { d: 'M4 9h11a5 5 0 0 1 0 10h-1' }],
    ]),
  trash: (): SVGElement =>
    icon([
      ['path', { d: 'M4 7h16' }],
      ['path', { d: 'M9 7V4h6v3' }],
      ['path', { d: 'M6 7l1 13h10l1-13' }],
    ]),
  copy: (): SVGElement =>
    icon([
      ['rect', { x: '9', y: '9', width: '11', height: '11', rx: '2' }],
      ['path', { d: 'M5 15V5a2 2 0 0 1 2-2h10' }],
    ]),
};

// The pen palette offered in the draw toolbar — a small, high-contrast set that reads on light and dark pages.
const DRAW_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#111827'];
const DRAW_WIDTH = 3.5; // pen width in CSS px

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
    width: 384px; max-height: min(86vh, 780px); background: #fff; border-radius: 12px; overflow: hidden;
    box-shadow: 0 10px 34px rgba(0,0,0,.26); border: 1px solid rgba(0,0,0,.08);
    display: flex; flex-direction: column; transition: width .16s ease;
  }
  /* The report form needs more room to fill in comfortably — widen the card while it's open. */
  .card.form-open { width: 464px; }
  .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(0,0,0,.07); flex: none; }
  .stat { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0; font-weight: 600; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #e0a800; flex: none; }
  .dot.on { background: #c0392b; animation: pulse 1.4s ease-in-out infinite; }
  .dot.ready { background: #1a7f37; animation: none; }
  .stat-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-weight: 400; font-variant-numeric: tabular-nums; opacity: .6; }
  .icon { border: 0; background: transparent; cursor: pointer; color: inherit; opacity: .5; padding: 5px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; }
  .icon:hover { opacity: 1; background: rgba(0,0,0,.06); }
  .icon svg { width: 16px; height: 16px; }
  .body { padding: 14px; display: grid; gap: 12px; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  .row { display: flex; gap: 8px; align-items: center; }
  .btn { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); background: #f5f5f7; color: #17171a; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .btn svg { width: 14px; height: 14px; }
  .btn:hover { background: #ececef; }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { background: #2563eb; color: #fff; border-color: transparent; }
  .btn.primary:hover { background: #1d4ed8; }
  .btn.rec.on { background: #c0392b; color: #fff; border-color: transparent; }
  .field { display: grid; gap: 5px; }
  .field > span { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; opacity: .55; }
  input, select, textarea { width: 100%; padding: 9px 11px; border: 1px solid #d3d3d8; border-radius: 8px; font: inherit; font-size: 13px; background: #fff; color: #17171a; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
  textarea { resize: vertical; min-height: 76px; line-height: 1.45; }
  .f-desc { min-height: 96px; }
  .msg { font-size: 12px; min-height: 0; }
  .msg.err { color: #c0392b; }
  .msg.ok { color: #1a7f37; }
  .hidden { display: none !important; }
  /* Post-stop review panel — the "you captured it, now report or discard" step. */
  .review { display: grid; gap: 10px; }
  .review-head { display: flex; align-items: center; gap: 7px; font-weight: 600; }
  .review-head svg { width: 16px; height: 16px; color: #1a7f37; }
  .review-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; opacity: .78; }
  .review-summary .r-sep { opacity: .3; }
  .review-summary .r-err { color: #c0392b; font-weight: 600; }
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
  .icon.draw-toggle.active { opacity: 1; color: #2563eb; }
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
  .pick-note {
    width: 190px; border: 0; border-radius: 999px; padding: 5px 12px; font: inherit;
    background: rgba(255,255,255,.14); color: #fff; outline: none;
  }
  .pick-note::placeholder { color: rgba(255,255,255,.55); }
  .pick-note:focus { background: rgba(255,255,255,.22); }
  .pick-note:disabled { opacity: .4; }
  /* Picked-elements list in the card — a note input per element (not just the last pick). */
  .picks { display: grid; gap: 7px; }
  .picks-head { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; opacity: .55; }
  .picks-head svg { width: 13px; height: 13px; opacity: .8; }
  .picks-list { display: grid; gap: 6px; max-height: 200px; overflow-y: auto; }
  .pick-item { border: 1px solid #e4e4e9; border-radius: 9px; padding: 8px; display: grid; gap: 6px; background: #fafafb; }
  .pick-item-top { display: flex; align-items: center; gap: 6px; }
  .pick-item-idx { flex: none; width: 16px; height: 16px; border-radius: 5px; background: #ececef; color: #555; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
  .pick-item code { flex: 1; min-width: 0; font: 11px/1.35 ui-monospace, Menlo, monospace; color: #17171a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pick-item .rm { flex: none; border: 0; background: transparent; cursor: pointer; opacity: .45; padding: 2px 5px; border-radius: 6px; color: inherit; font-size: 15px; line-height: 1; }
  .pick-item .rm:hover { opacity: 1; background: rgba(0,0,0,.06); }
  .pick-item input { padding: 7px 9px; font-size: 12.5px; border-radius: 7px; }
  /* Full-viewport freehand drawing surface — lives in the blocked Shadow DOM so rrweb never records it.
     Sits under the toolbar/card (max z) but over the page; only interactive while draw mode is on. */
  .draw-canvas { position: fixed; inset: 0; z-index: 2147483640; display: none; cursor: crosshair; touch-action: none; }
  .draw-canvas.on { display: block; }
  .draw-bar {
    position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483647; display: none;
    align-items: center; gap: 8px; background: #17171a; color: #fff; border-radius: 999px;
    padding: 6px 8px 6px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.32);
    font: 12px/1.4 -apple-system, system-ui, sans-serif;
  }
  .draw-bar.on { display: flex; }
  .draw-bar .lead { display: inline-flex; align-items: center; gap: 7px; opacity: .85; }
  .draw-bar svg { width: 15px; height: 15px; }
  .draw-bar .sep { width: 1px; height: 18px; background: rgba(255,255,255,.18); }
  .swatches { display: inline-flex; gap: 5px; }
  .swatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
  .swatch.active { border-color: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.3); }
  .draw-icon-btn {
    border: 0; cursor: pointer; border-radius: 999px; width: 28px; height: 28px; display: inline-flex;
    align-items: center; justify-content: center; background: rgba(255,255,255,.14); color: #fff;
  }
  .draw-icon-btn:hover { background: rgba(255,255,255,.24); }
  .draw-icon-btn:disabled { opacity: .4; cursor: default; }
  .draw-icon-btn svg { width: 15px; height: 15px; }
  /* Credentials block in the report form — a light inset card the QA can leave blank. */
  .cred { display: grid; gap: 8px; padding: 10px; border: 1px dashed rgba(0,0,0,.16); border-radius: 8px; background: rgba(0,0,0,.015); }
  .cred-hint { font-size: 11px; opacity: .55; margin: 0; display: flex; align-items: center; gap: 5px; }
  .cred-hint svg { width: 13px; height: 13px; }
  .pw-wrap { position: relative; }
  .pw-wrap input { padding-right: 34px; }
  .reveal { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); border: 0; background: transparent; cursor: pointer; color: inherit; opacity: .5; padding: 5px; border-radius: 6px; display: inline-flex; }
  .reveal:hover { opacity: 1; }
  .reveal svg { width: 15px; height: 15px; }
  .health { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 11px; opacity: .8; margin: -2px 0 2px; }
  .health .h-chip { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .health .h-rec { color: #c0392b; font-weight: 600; font-variant-numeric: tabular-nums; }
  .health .h-err { color: #c0392b; font-weight: 600; }
  .health .h-sep { opacity: .3; }
  .kbd-hint { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 10.5px; opacity: .5; padding: 8px 12px 10px; flex: none; }
  .kbd-hint span { display: inline-flex; align-items: center; gap: 4px; }
  .kbd-hint kbd { font: 10px/1 ui-monospace, Menlo, monospace; background: rgba(0,0,0,.07); border-radius: 3px; padding: 2px 4px; }
  .pick-sel { display: none; align-items: center; gap: 6px; max-width: 240px; margin-left: 2px; }
  .pick-sel.on { display: inline-flex; }
  .pick-sel code { font: 11px/1.4 ui-monospace, Menlo, monospace; color: #fff; opacity: .9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pick-sel .copy { border: 0; background: rgba(255,255,255,.16); color: #fff; border-radius: 6px; padding: 3px 5px; cursor: pointer; display: inline-flex; }
  .pick-sel .copy:hover { background: rgba(255,255,255,.28); }
  .pick-sel .copy svg { width: 13px; height: 13px; }
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
    .cred { border-color: rgba(255,255,255,.14); background: rgba(255,255,255,.02); }
    .kbd-hint kbd { background: rgba(255,255,255,.1); }
    .pick-item { background: rgba(255,255,255,.03); border-color: #3a3a40; }
    .pick-item code { color: #ececee; }
    .pick-item-idx { background: #34343a; color: #bcbcc2; }
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
  const drawBtn = h('button', { class: 'icon draw-toggle', type: 'button', 'aria-label': 'Draw on the page', 'aria-pressed': 'false', title: 'Draw on the page' }, ICONS.pen());
  const notesBtn = h('button', { class: 'icon notes-toggle', type: 'button', 'aria-label': 'QA notes', 'aria-expanded': 'false', title: 'QA notes' }, ICONS.note());
  const collapseBtn = h('button', { class: 'icon', type: 'button', 'aria-label': 'Collapse recorder', title: 'Collapse' }, ICONS.chevronDown());
  const hd = h('div', { class: 'hd' }, stat, pickBtn, drawBtn, notesBtn, collapseBtn);

  // Record button: a swappable icon + a text label kept in its own span so the recording-state update can
  // retitle it without clobbering the icon.
  const recIconWrap = h('span', { class: 'rec-icon' }, ICONS.record());
  const recLabel = h('span', {}, 'Start');
  const recBtn = h('button', { class: 'btn rec', type: 'button' }, recIconWrap, recLabel);
  const markBtn = h('button', { class: 'btn', type: 'button', 'aria-label': 'Mark the bug moment' }, ICONS.flag(), h('span', {}, 'Mark'));
  const reportBtn = h('button', { class: 'btn primary', type: 'button' }, 'Report');
  const actions = h('div', { class: 'row' }, recBtn, markBtn, reportBtn);

  // Post-stop review panel: after an explicit take is stopped, surface a clear "report or discard" step.
  const reviewSummary = h('div', { class: 'review-summary' });
  const reviewReportBtn = h('button', { class: 'btn primary', type: 'button' }, ICONS.bug(), h('span', {}, 'Report bug'));
  const reviewDiscardBtn = h('button', { class: 'btn', type: 'button' }, ICONS.trash(), h('span', {}, 'Discard'));
  const reviewPanel = h(
    'div',
    { class: 'review hidden', role: 'group', 'aria-label': 'Recording captured' },
    h('div', { class: 'review-head' }, ICONS.record(), h('span', {}, 'Recording captured')),
    reviewSummary,
    h('div', { class: 'row' }, reviewDiscardBtn, reviewReportBtn),
  );

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
  // Test credentials — the login the reporter was using, so a developer can reproduce with the same account.
  // Left blank ⇒ omitted from the report. Password is masked by default with a reveal toggle.
  const fCredUser = h('input', { class: 'f-cred-user', type: 'text', autocomplete: 'off', placeholder: 'email / username' });
  const fCredPass = h('input', { class: 'f-cred-pass', type: 'password', autocomplete: 'off', placeholder: 'password' });
  const revealBtn = h('button', { class: 'reveal', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false' }, ICONS.eye());
  const fCredNotes = h('input', { class: 'f-cred-notes', type: 'text', placeholder: 'role, tenant, 2FA… (optional)' });
  const credBlock = h(
    'div',
    { class: 'cred' },
    h('p', { class: 'cred-hint' }, ICONS.key(), 'Test login used (optional) — helps devs reproduce'),
    h(
      'div',
      { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'Username'), fCredUser),
      h('label', { class: 'field' }, h('span', {}, 'Password'), h('div', { class: 'pw-wrap' }, fCredPass, revealBtn)),
    ),
    h('label', { class: 'field' }, h('span', {}, 'Other'), fCredNotes),
  );
  const cancelBtn = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Send report');
  const msg = h('div', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  // "Capture health" — what the report will actually contain, refreshed each time the form opens.
  const healthLine = h('div', { class: 'health', 'aria-live': 'polite' });
  const form = h(
    'form',
    { class: 'form hidden' },
    healthLine,
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
    credBlock,
    h('div', { class: 'row' }, cancelBtn, submitBtn),
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

  // Picked-elements list — a note input PER element (not just the last pick). Rebuilt from pickedElements only
  // when the set changes (never on the 1s render tick), so a note the QA is typing is never clobbered.
  const picksList = h('div', { class: 'picks-list' });
  const picksHeadLabel = h('span', {}, 'Picked elements');
  const picksPanel = h(
    'div',
    { class: 'picks hidden', role: 'group', 'aria-label': 'Picked elements' },
    h('div', { class: 'picks-head' }, ICONS.crosshair(), picksHeadLabel),
    picksList,
  );

  const body = h('div', { class: 'body' }, picksPanel, actions, reviewPanel, markRow, form, msg);
  // Keyboard-shortcut hint — the shortcuts only fire while the widget itself is focused (so they never clash
  // with the host page). Hidden while the report form is open (the letters would fight the text fields).
  const kbd = (k: string) => h('kbd', {}, k);
  const kbdHint = h(
    'div',
    { class: 'kbd-hint', 'aria-hidden': 'true' },
    h('span', {}, kbd('R'), 'Rec'),
    h('span', {}, kbd('M'), 'Mark'),
    h('span', {}, kbd('P'), 'Pick'),
    h('span', {}, kbd('D'), 'Draw'),
    h('span', {}, kbd('N'), 'Notes'),
  );
  const card = h('div', { class: 'card hidden', tabindex: '-1' }, hd, notesPanel, body, kbdHint);
  root.append(bubble, card);
  shadow.append(root);

  // Element-picker overlay — a highlight outline + label that follow the hovered element, plus a control
  // banner. All in the Shadow DOM under BLOCK_CLASS, so rrweb never records the highlight or the toolbar.
  const pickOutline = h('div', { class: 'pick-outline', 'aria-hidden': 'true' });
  const pickLabel = h('div', { class: 'pick-label', 'aria-hidden': 'true' });
  const pickCount = h('span', { class: 'count' }, '0 picked');
  // The last-picked element's selector, one-click copyable — a dev's quickest path to the node.
  const pickSelCode = h('code', {});
  const pickSelCopy = h('button', { class: 'copy', type: 'button', 'aria-label': 'Copy selector', title: 'Copy selector' }, ICONS.copy());
  const pickSel = h('div', { class: 'pick-sel', 'aria-label': 'Last picked selector' }, pickSelCode, pickSelCopy);
  // Annotate the most-recently-picked element — "why does this matter" in the reporter's words.
  const pickNote = h('input', { class: 'pick-note', type: 'text', 'aria-label': 'Note for the last picked element', placeholder: 'Add a note for this pick…' });
  const pickClearBtn = h('button', { class: 'pill-btn', type: 'button' }, 'Clear');
  const pickDoneBtn = h('button', { class: 'pill-btn primary', type: 'button' }, 'Done');
  const pickBanner = h(
    'div',
    { class: 'pick-banner', role: 'region', 'aria-label': 'Element picker' },
    h('span', { class: 'lead' }, ICONS.crosshair(), h('span', {}, 'Click to pick · Esc to exit')),
    pickCount,
    pickSel,
    pickNote,
    pickClearBtn,
    pickDoneBtn,
  );

  // Full-viewport freehand drawing surface + its toolbar. Both live in the blocked Shadow DOM, so rrweb
  // never records them — the strokes ride to the dashboard as data and replay as a synced overlay instead.
  const drawCanvas = h('canvas', { class: 'draw-canvas', 'aria-hidden': 'true' });
  const drawSwatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Pen color' });
  const drawUndoBtn = h('button', { class: 'draw-icon-btn', type: 'button', 'aria-label': 'Undo last stroke', title: 'Undo' }, ICONS.undo());
  const drawClearBtn = h('button', { class: 'draw-icon-btn', type: 'button', 'aria-label': 'Clear drawing', title: 'Clear' }, ICONS.trash());
  const drawDoneBtn = h('button', { class: 'pill-btn primary', type: 'button' }, 'Done');
  const drawBar = h(
    'div',
    { class: 'draw-bar', role: 'region', 'aria-label': 'Draw on the page' },
    h('span', { class: 'lead' }, ICONS.pen(), h('span', {}, 'Draw to annotate')),
    h('span', { class: 'sep', 'aria-hidden': 'true' }),
    drawSwatches,
    h('span', { class: 'sep', 'aria-hidden': 'true' }),
    drawUndoBtn,
    drawClearBtn,
    drawDoneBtn,
  );

  shadow.append(pickOutline, pickLabel, pickBanner, drawCanvas, drawBar);
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
  let drawMode = false;
  let drawStrokes: DrawStroke[] = [];
  let drawColor = DRAW_COLORS[0];
  let collapsedBeforeDraw = false;
  let healthToken = 0; // guards the async capture-health fetch against a stale render
  let reviewOpen = false; // an explicit take was just stopped — awaiting report/discard
  let reviewHealth: CaptureHealth | null = null; // capture snapshot shown in the review panel
  let reportFromReview = false; // remembers whether the report form was opened from the review step

  const hasNotes = () => !!(nText.value.trim() || nExpected.value.trim() || nActual.value.trim());

  const setMsg = (text: string, kind?: 'err' | 'ok') => {
    msg.textContent = text;
    msg.className = 'msg' + (kind ? ' ' + kind : '');
  };

  function render() {
    // In pick/draw mode the card + bubble tuck away; the mode's banner + overlay drive the session.
    const overlayMode = pickMode || drawMode;
    bubble.classList.toggle('hidden', !collapsed || overlayMode);
    card.classList.toggle('hidden', collapsed);
    bubble.classList.toggle('rec', cb.isRecording());
    card.classList.toggle('form-open', formOpen); // widen the card while filling the report form
    markRow.classList.toggle('hidden', !markOpen);
    form.classList.toggle('hidden', !formOpen);
    actions.classList.toggle('hidden', formOpen || reviewOpen);
    reviewPanel.classList.toggle('hidden', !reviewOpen || formOpen);
    notesPanel.classList.toggle('open', notesOpen);
    notesPanel.setAttribute('aria-hidden', notesOpen ? 'false' : 'true');
    notesBtn.setAttribute('aria-expanded', notesOpen ? 'true' : 'false');
    notesBtn.classList.toggle('has-notes', hasNotes());
    pickBtn.classList.toggle('active', pickMode);
    pickBtn.setAttribute('aria-pressed', pickMode ? 'true' : 'false');
    pickBanner.classList.toggle('on', pickMode);
    pickCount.textContent = `${pickedElements.length} picked`;
    pickClearBtn.disabled = pickedElements.length === 0;
    // The note field annotates the most-recent pick; keep it in sync unless the QA is mid-type.
    const lastPick = pickedElements[pickedElements.length - 1] ?? null;
    pickNote.disabled = !lastPick;
    if (shadow.activeElement !== pickNote) pickNote.value = lastPick?.note ?? '';
    // The last-pick selector chip (copyable).
    pickSel.classList.toggle('on', !!lastPick?.selector);
    if (pickSelCode.textContent !== (lastPick?.selector ?? '')) {
      pickSelCode.textContent = lastPick?.selector ?? '';
      pickSelCode.setAttribute('title', lastPick?.selector ?? '');
    }
    // Shortcut hint shows only in the default card view (not while filling the report form).
    kbdHint.classList.toggle('hidden', formOpen || reviewOpen);
    renderPicksList();
    drawBtn.classList.toggle('active', drawMode);
    drawBtn.setAttribute('aria-pressed', drawMode ? 'true' : 'false');
    drawBar.classList.toggle('on', drawMode);
    drawCanvas.classList.toggle('on', drawMode);
    drawUndoBtn.disabled = drawStrokes.length === 0;
    drawClearBtn.disabled = drawStrokes.length === 0;

    const recording = cb.isRecording();
    recLabel.textContent = recording ? 'Stop' : 'Start';
    recIconWrap.replaceChildren(recording ? ICONS.stop() : ICONS.record());
    recBtn.classList.toggle('on', recording);
    dot.classList.toggle('on', recording);
    dot.classList.toggle('ready', !recording && reviewOpen);

    if (recording) {
      statText.textContent = 'Recording';
      const startedAt = cb.explicitStartedAt();
      sub.textContent = startedAt ? fmtElapsed(Date.now() - startedAt) : '';
    } else if (reviewOpen) {
      statText.textContent = 'Captured';
      sub.textContent = reviewHealth ? fmtElapsed(reviewHealth.durationMs) : 'ready to report';
    } else {
      statText.textContent = 'Buffering';
      sub.textContent = 'last 2 min';
    }
    reportBtn.disabled = busy;
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? 'Sending…' : 'Send report';
  }

  // Rebuild the per-element picks list ONLY when the set of picked elements changes (add/remove) — never on
  // the 1s render tick — so a note the QA is mid-typing is never wiped. Each row carries its own note input
  // bound to that element object (by reference), so notes attach to EACH element, not just the last pick.
  let lastPicksSig = ' ';
  const renderPicksList = () => {
    const has = pickedElements.length > 0;
    picksPanel.classList.toggle('hidden', !has || formOpen || reviewOpen);
    picksHeadLabel.textContent = has ? `Picked elements · ${pickedElements.length}` : 'Picked elements';
    if (!has) {
      picksList.replaceChildren();
      lastPicksSig = '';
      return;
    }
    const sig = pickedElements.map((p) => p.selector).join('');
    if (sig === lastPicksSig) return; // membership unchanged — leave the inputs (and any in-progress typing) alone
    lastPicksSig = sig;
    const rows = pickedElements.map((el, i) => {
      const code = h('code', { title: el.selector }, el.selector);
      const rm = h('button', { class: 'rm', type: 'button', 'aria-label': 'Remove picked element', title: 'Remove' }, '×');
      rm.addEventListener('click', () => {
        const idx = pickedElements.indexOf(el);
        if (idx >= 0) pickedElements.splice(idx, 1);
        render();
      });
      const note = h('input', { type: 'text', 'aria-label': `Note for ${el.selector}`, placeholder: 'Add a note for this element…' });
      note.value = el.note ?? '';
      note.addEventListener('input', () => {
        el.note = note.value.slice(0, 500);
      });
      note.addEventListener('keydown', (e) => e.stopPropagation()); // typing here must never trigger card shortcuts / Esc
      const idx = h('span', { class: 'pick-item-idx' }, String(i + 1));
      return h('div', { class: 'pick-item' }, h('div', { class: 'pick-item-top' }, idx, code, rm), note);
    });
    picksList.replaceChildren(...rows);
  };

  // Live tick so the elapsed clock + rolling/explicit state stay current.
  const timer = window.setInterval(render, 1000);

  // --- interactions ---
  bubble.addEventListener('click', () => {
    collapsed = false;
    render();
    card.focus(); // so the letter shortcuts work right after opening (this listener is shadow-scoped)
  });
  collapseBtn.addEventListener('click', () => {
    collapsed = true;
    markOpen = false;
    formOpen = false;
    notesOpen = false;
    reviewOpen = false;
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
    if (drawMode) exitDraw(); // pick + draw both take over the screen — only one at a time
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
  // The note field annotates the most-recently-picked element (the one the overlay just added).
  pickNote.addEventListener('input', () => {
    const last = pickedElements[pickedElements.length - 1];
    if (last) last.note = pickNote.value.slice(0, 500);
  });
  pickNote.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      pickNote.blur();
    }
    e.stopPropagation(); // don't let Esc/keys bubble to the picker's global shield
  });
  // Copy the last-picked selector. The click is a user gesture, so the async clipboard write is allowed;
  // fall back to a hidden textarea + execCommand on older/blocked contexts.
  const copyText = (text: string) => {
    try {
      navigator.clipboard?.writeText(text).catch(() => fallbackCopy(text));
    } catch {
      fallbackCopy(text);
    }
  };
  const fallbackCopy = (text: string) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch {
      /* clipboard unavailable — nothing more we can do */
    }
  };
  pickSelCopy.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const last = pickedElements[pickedElements.length - 1];
    if (!last?.selector) return;
    copyText(last.selector);
    const prev = pickSelCopy.innerHTML;
    pickSelCopy.textContent = '✓';
    window.setTimeout(() => {
      pickSelCopy.innerHTML = prev;
    }, 1000);
  });

  // --- drawing overlay ---
  // Pen palette swatches — click to set the active color; the selected one wears a ring.
  const swatchEls: HTMLButtonElement[] = [];
  for (const c of DRAW_COLORS) {
    const b = h('button', { class: 'swatch', type: 'button', 'aria-label': `Pen color ${c}`, title: c });
    b.style.background = c;
    if (c === drawColor) b.classList.add('active');
    b.addEventListener('click', () => {
      drawColor = c;
      for (const s of swatchEls) s.classList.toggle('active', s === b);
    });
    swatchEls.push(b);
    drawSwatches.append(b);
  }

  const drawCtx = () => drawCanvas.getContext('2d');
  // Size the canvas to the viewport in device pixels, then work in CSS px (crisp lines on HiDPI).
  const sizeDrawCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    drawCanvas.width = Math.max(1, Math.round(w * dpr));
    drawCanvas.height = Math.max(1, Math.round(hgt * dpr));
    drawCanvas.style.width = w + 'px';
    drawCanvas.style.height = hgt + 'px';
    const ctx = drawCtx();
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
  };
  const paintStroke = (ctx: CanvasRenderingContext2D, s: DrawStroke) => {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    if (s.points.length === 0) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x * w, s.points[0].y * hgt);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * w, s.points[i].y * hgt);
    if (s.points.length === 1) ctx.lineTo(s.points[0].x * w + 0.1, s.points[0].y * hgt); // a single tap ⇒ a dot
    ctx.stroke();
  };
  const redrawDraw = () => {
    const ctx = drawCtx();
    if (!ctx) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const s of drawStrokes) paintStroke(ctx, s);
    if (curStroke) paintStroke(ctx, curStroke);
  };

  let curStroke: DrawStroke | null = null;
  let drawing = false;
  const normPt = (e: PointerEvent) => ({
    x: Math.min(1, Math.max(0, e.clientX / Math.max(1, window.innerWidth))),
    y: Math.min(1, Math.max(0, e.clientY / Math.max(1, window.innerHeight))),
  });
  const finishStroke = () => {
    drawing = false;
    if (!curStroke) return;
    curStroke.tEnd = Date.now();
    if (curStroke.points.length > 0 && drawStrokes.length < 500) drawStrokes.push(curStroke);
    curStroke = null;
    render();
  };
  drawCanvas.addEventListener('pointerdown', (e) => {
    if (!drawMode || e.button !== 0) return;
    e.preventDefault();
    drawing = true;
    try {
      drawCanvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const now = Date.now();
    curStroke = { ts: now, tEnd: now, color: drawColor, width: DRAW_WIDTH, points: [normPt(e)] };
    redrawDraw();
  });
  drawCanvas.addEventListener('pointermove', (e) => {
    if (!drawing || !curStroke) return;
    e.preventDefault();
    curStroke.points.push(normPt(e));
    curStroke.tEnd = Date.now();
    const ctx = drawCtx(); // draw just the new segment — cheap even for long strokes
    if (ctx && curStroke.points.length >= 2) {
      const w = window.innerWidth;
      const hgt = window.innerHeight;
      const a = curStroke.points[curStroke.points.length - 2];
      const b = curStroke.points[curStroke.points.length - 1];
      ctx.strokeStyle = curStroke.color;
      ctx.lineWidth = curStroke.width;
      ctx.beginPath();
      ctx.moveTo(a.x * w, a.y * hgt);
      ctx.lineTo(b.x * w, b.y * hgt);
      ctx.stroke();
    }
  });
  const endStroke = (e: PointerEvent) => {
    if (!drawing) return;
    e.preventDefault();
    try {
      drawCanvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    finishStroke();
  };
  drawCanvas.addEventListener('pointerup', endStroke);
  drawCanvas.addEventListener('pointercancel', endStroke);

  const onDrawResize = () => {
    sizeDrawCanvas();
    redrawDraw();
  };
  const onDrawKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    exitDraw();
  };
  function enterDraw() {
    if (drawMode) return;
    if (pickMode) exitPick();
    drawMode = true;
    collapsedBeforeDraw = collapsed;
    collapsed = true; // tuck the card away — the draw bar + canvas drive the session
    markOpen = formOpen = notesOpen = false;
    window.addEventListener('resize', onDrawResize);
    document.addEventListener('keydown', onDrawKey, true);
    render(); // flips the canvas to display:block before we size it
    sizeDrawCanvas();
    redrawDraw();
  }
  function exitDraw() {
    if (!drawMode) return;
    finishStroke();
    drawMode = false;
    window.removeEventListener('resize', onDrawResize);
    document.removeEventListener('keydown', onDrawKey, true);
    collapsed = collapsedBeforeDraw;
    render();
  }
  drawBtn.addEventListener('click', () => {
    if (drawMode) exitDraw();
    else enterDraw();
  });
  drawDoneBtn.addEventListener('click', exitDraw);
  drawUndoBtn.addEventListener('click', () => {
    drawStrokes.pop();
    redrawDraw();
    render();
  });
  drawClearBtn.addEventListener('click', () => {
    drawStrokes = [];
    redrawDraw();
    render();
  });

  // Password reveal toggle in the report form.
  let pwVisible = false;
  revealBtn.addEventListener('click', () => {
    pwVisible = !pwVisible;
    fCredPass.type = pwVisible ? 'text' : 'password';
    revealBtn.setAttribute('aria-pressed', pwVisible ? 'true' : 'false');
    revealBtn.setAttribute('aria-label', pwVisible ? 'Hide password' : 'Show password');
    revealBtn.replaceChildren(pwVisible ? ICONS.eyeOff() : ICONS.eye());
  });
  // Build the current credentials block into a TestCredentials, or undefined when every field is blank.
  const readCredentials = (): TestCredentials | undefined => {
    const username = fCredUser.value.trim();
    const password = fCredPass.value; // never trim a password
    const credNotes = fCredNotes.value.trim();
    if (!username && !password && !credNotes) return undefined;
    const c: TestCredentials = {};
    if (username) c.username = username;
    if (password) c.password = password;
    if (credNotes) c.notes = credNotes;
    return c;
  };

  recBtn.addEventListener('click', () => {
    if (cb.isRecording()) {
      cb.onStop();
      reviewOpen = true; // stopping opens the report-or-discard review step
      reportFromReview = false;
      snapshotReviewHealth();
    } else {
      cb.onStart();
      reviewOpen = false;
    }
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
  // "Capture health" line — compose from the async network/console/error counts plus the widget's own
  // picked/drawing counts, so the reporter sees exactly what the report will contain.
  const renderHealthLine = (health: CaptureHealth | null) => {
    const chip = (text: string, cls?: string) => h('span', { class: 'h-chip' + (cls ? ' ' + cls : '') }, text);
    const sep = () => h('span', { class: 'h-sep', 'aria-hidden': 'true' }, '·');
    if (!health) {
      healthLine.replaceChildren(chip('Checking capture…'));
      return;
    }
    const nodes: Node[] = [h('span', { class: 'h-chip h-rec' }, (cb.isRecording() ? '● ' : '') + fmtElapsed(health.durationMs))];
    nodes.push(sep(), chip(`${health.network} network`), sep(), chip(`${health.console} console`));
    if (health.errors > 0) nodes.push(sep(), chip(`${health.errors} error${health.errors === 1 ? '' : 's'}`, 'h-err'));
    if (pickedElements.length) nodes.push(sep(), chip(`${pickedElements.length} picked`));
    if (drawStrokes.length) nodes.push(sep(), chip(`${drawStrokes.length} drawing${drawStrokes.length === 1 ? '' : 's'}`));
    healthLine.replaceChildren(...nodes);
  };
  const refreshHealth = () => {
    if (!cb.captureHealth) {
      healthLine.replaceChildren();
      return;
    }
    renderHealthLine(null);
    const token = ++healthToken;
    cb.captureHealth().then(
      (hd) => {
        if (token === healthToken && formOpen) renderHealthLine(hd);
      },
      () => {
        if (token === healthToken) healthLine.replaceChildren();
      },
    );
  };

  // --- review (post-stop) helpers ---
  const renderReviewSummary = () => {
    const chip = (text: string, cls?: string) => h('span', { class: 'r-chip' + (cls ? ' ' + cls : '') }, text);
    const sep = () => h('span', { class: 'r-sep', 'aria-hidden': 'true' }, '·');
    if (!reviewHealth) {
      reviewSummary.replaceChildren(h('span', {}, 'Everything you just did is captured. Report it, or discard.'));
      return;
    }
    const hd = reviewHealth;
    const nodes: Node[] = [chip(fmtElapsed(hd.durationMs) + ' recorded')];
    nodes.push(sep(), chip(`${hd.network} network`), sep(), chip(`${hd.console} console`));
    if (hd.errors > 0) nodes.push(sep(), chip(`${hd.errors} error${hd.errors === 1 ? '' : 's'}`, 'r-err'));
    if (pickedElements.length) nodes.push(sep(), chip(`${pickedElements.length} picked`));
    if (drawStrokes.length) nodes.push(sep(), chip(`${drawStrokes.length} drawing${drawStrokes.length === 1 ? '' : 's'}`));
    reviewSummary.replaceChildren(...nodes);
  };
  const snapshotReviewHealth = () => {
    reviewHealth = null;
    renderReviewSummary();
    if (!cb.captureHealth) return;
    const token = ++healthToken;
    cb.captureHealth().then(
      (hd) => {
        if (token === healthToken && reviewOpen) {
          reviewHealth = hd;
          renderReviewSummary();
          render();
        }
      },
      () => {
        /* leave the placeholder summary in place */
      },
    );
  };
  const openReportForm = (fromReview: boolean) => {
    reportFromReview = fromReview;
    formOpen = true;
    reviewOpen = false;
    markOpen = false;
    notesOpen = false;
    loadTaxonomyOnce();
    refreshHealth();
    setMsg('');
    render();
    fTitle.focus();
  };
  const discardCapture = () => {
    cb.onDiscard?.(); // drop the take in the recorder buffer
    reviewOpen = false;
    reportFromReview = false;
    pickedElements = [];
    drawStrokes = [];
    curStroke = null;
    redrawDraw();
    nText.value = '';
    nExpected.value = '';
    nActual.value = '';
    setMsg('');
    render();
  };
  reviewReportBtn.addEventListener('click', () => openReportForm(true));
  reviewDiscardBtn.addEventListener('click', discardCapture);

  reportBtn.addEventListener('click', () => openReportForm(false));
  cancelBtn.addEventListener('click', () => {
    formOpen = false;
    reviewOpen = reportFromReview; // return to the review step if we came from it, else back to idle
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
      drawings: drawStrokes.slice(),
      credentials: readCredentials(),
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
          fTags.value = ''; // tags are per-bug; team/project + test login persist for filing a batch
          nText.value = '';
          nExpected.value = '';
          nActual.value = '';
          pickedElements = [];
          drawStrokes = [];
          curStroke = null;
          redrawDraw();
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

  // Esc peels back one layer at a time; keeps the widget keyboard-dismissible. Single-letter shortcuts (R/M/
  // P/D/N) drive the core actions. This listener is on the shadow root, so it only fires when the widget
  // itself is focused — page keystrokes never reach here, so the shortcuts can't clash with the host page.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (formOpen) {
        formOpen = false;
        reviewOpen = reportFromReview; // Esc out of the form falls back to the review step if we came from it
      } else if (reviewOpen) reviewOpen = false;
      else if (markOpen) markOpen = false;
      else if (notesOpen) notesOpen = false;
      else if (!collapsed) collapsed = true;
      else return;
      e.stopPropagation();
      render();
      return;
    }
    // Letter shortcuts: only in the open card view, no modifier, and not while typing in a field.
    if (collapsed || formOpen || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key.toLowerCase()) {
      case 'r':
        take();
        recBtn.click();
        break;
      case 'm':
        take();
        markBtn.click();
        break;
      case 'p':
        take();
        if (pickMode) exitPick();
        else enterPick();
        break;
      case 'd':
        take();
        if (drawMode) exitDraw();
        else enterDraw();
        break;
      case 'n':
        take();
        notesBtn.click();
        break;
    }
  };
  root.addEventListener('keydown', onKey);

  render();

  return {
    destroy() {
      window.clearInterval(timer);
      root.removeEventListener('keydown', onKey);
      removePickListeners(); // no-op if pick mode was never entered
      window.removeEventListener('resize', onDrawResize); // no-ops if draw mode was never entered
      document.removeEventListener('keydown', onDrawKey, true);
      host.remove();
    },
  };
}

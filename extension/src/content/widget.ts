// ABOUTME: In-page recorder widget — a floating, themed, accessible control mounted in a Shadow DOM root
// ABOUTME: (host wears BLOCK_CLASS so rrweb never records it). Start/Stop, Mark, live indicator, Report form.
import { BLOCK_CLASS } from './recorder';

export type ReportForm = { title: string; severity: string; description: string };

export type WidgetCallbacks = {
  isRecording: () => boolean; // an explicit take is in progress
  explicitStartedAt: () => number | null; // epoch ms, for the elapsed clock
  onStart: () => void;
  onStop: () => void;
  onMark: (label?: string) => void;
  onReport: (form: ReportForm) => Promise<{ ok: boolean; message: string }>;
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
    background: #2563eb; color: #fff; font-size: 18px; line-height: 44px; text-align: center;
    box-shadow: 0 6px 20px rgba(0,0,0,.28); transition: transform .12s ease;
  }
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
  .icon { border: 0; background: transparent; cursor: pointer; color: inherit; opacity: .55; font-size: 15px; padding: 2px 6px; border-radius: 6px; }
  .icon:hover { opacity: 1; background: rgba(0,0,0,.06); }
  .body { padding: 12px; display: grid; gap: 10px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .btn { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); background: #f5f5f7; color: #17171a; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
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
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  @media (prefers-color-scheme: dark) {
    .root { color: #ececee; }
    .card { background: #1f1f22; border-color: rgba(255,255,255,.08); }
    .hd { border-color: rgba(255,255,255,.08); }
    .icon:hover { background: rgba(255,255,255,.08); }
    .btn { background: #2c2c30; color: #ececee; border-color: rgba(255,255,255,.12); }
    .btn:hover { background: #34343a; }
    input, select, textarea { background: #2c2c30; color: #ececee; border-color: #3a3a40; }
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
  const bubble = h('button', { class: 'bubble', type: 'button', 'aria-label': 'Open be10x bug recorder', title: 'be10x bug recorder' }, '●');

  // Expanded card
  const dot = h('span', { class: 'dot' });
  const statText = h('span', { class: 'stat-text' }, 'Ready');
  const sub = h('span', { class: 'sub' });
  const stat = h('span', { class: 'stat' }, dot, statText, sub);
  const collapseBtn = h('button', { class: 'icon', type: 'button', 'aria-label': 'Collapse recorder', title: 'Collapse' }, '–');
  const hd = h('div', { class: 'hd' }, stat, collapseBtn);

  const recBtn = h('button', { class: 'btn rec', type: 'button' }, '● Start');
  const markBtn = h('button', { class: 'btn', type: 'button', 'aria-label': 'Mark the bug moment' }, '⚑ Mark');
  const reportBtn = h('button', { class: 'btn primary', type: 'button' }, 'Report');
  const actions = h('div', { class: 'row' }, recBtn, markBtn, reportBtn);

  // Optional mark-label row
  const markInput = h('input', { class: 'mark-input', type: 'text', 'aria-label': 'Marker label', placeholder: 'This is the bug' });
  const markConfirm = h('button', { class: 'btn primary', type: 'button', 'aria-label': 'Place marker' }, '⚑');
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
  const cancelBtn = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Send report');
  const msg = h('div', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  const form = h(
    'form',
    { class: 'form hidden' },
    h('label', { class: 'field' }, h('span', {}, 'Title'), fTitle),
    h('label', { class: 'field' }, h('span', {}, 'Severity'), fSev),
    h('label', { class: 'field' }, h('span', {}, 'Description'), fDesc),
    h('div', { class: 'row' }, cancelBtn, submitBtn),
    msg,
  );

  const body = h('div', { class: 'body' }, actions, markRow, form);
  const card = h('div', { class: 'card hidden' }, hd, body);
  root.append(bubble, card);
  shadow.append(root);
  document.documentElement.append(host);

  // --- state ---
  let collapsed = false;
  let markOpen = false;
  let formOpen = false;
  let busy = false;

  const setMsg = (text: string, kind?: 'err' | 'ok') => {
    msg.textContent = text;
    msg.className = 'msg' + (kind ? ' ' + kind : '');
  };

  function render() {
    bubble.classList.toggle('hidden', !collapsed);
    card.classList.toggle('hidden', collapsed);
    bubble.classList.toggle('rec', cb.isRecording());
    markRow.classList.toggle('hidden', !markOpen);
    form.classList.toggle('hidden', !formOpen);
    actions.classList.toggle('hidden', formOpen);

    const recording = cb.isRecording();
    recBtn.textContent = recording ? '■ Stop' : '● Start';
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
    render();
  });

  recBtn.addEventListener('click', () => {
    if (cb.isRecording()) cb.onStop();
    else cb.onStart();
    render();
  });

  markBtn.addEventListener('click', () => {
    markOpen = !markOpen;
    formOpen = false;
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

  reportBtn.addEventListener('click', () => {
    formOpen = true;
    markOpen = false;
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
    cb.onReport({ title, severity: fSev.value, description: fDesc.value.trim() })
      .then((r) => {
        busy = false;
        setMsg(r.message, r.ok ? 'ok' : 'err');
        if (r.ok) {
          fTitle.value = '';
          fDesc.value = '';
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
      host.remove();
    },
  };
}

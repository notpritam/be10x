// ABOUTME: Popup UI — connect to a be10x board (device auth), report the current page, and log out.
// ABOUTME: Sends messages to the service worker and polls status so it flips to "connected" even when the
// ABOUTME: approval tab steals focus and closes this popup. All network egress lives in the service worker.
import { useEffect, useRef, useState } from 'react';

const DEFAULT_BOARD = 'https://be10x.notpritam.in';

type BoardUser = { displayName?: string; email?: string };
type Status = { connected: boolean; boardUrl?: string; user?: BoardUser };
type Phase = 'loading' | 'disconnected' | 'connecting' | 'connected';
type Msg = { t: string; kind?: 'err' | 'ok' } | null;

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  .wrap { width: 340px; font: 13px/1.45 -apple-system, system-ui, sans-serif; color: #17171a; background: #fff; }
  .hd { display: flex; align-items: center; gap: 8px; padding: 13px 16px; border-bottom: 1px solid rgba(128,128,128,.2); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #c0392b; flex: none; }
  .dot.on { background: #2ea043; }
  .title { font-weight: 600; }
  .body { padding: 16px; display: grid; gap: 12px; }
  .field { display: grid; gap: 5px; }
  .field label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  .field input, .field select { padding: 8px 10px; border: 1px solid #d3d3d8; border-radius: 8px; font-size: 13px; width: 100%; }
  .field input:focus, .field select:focus { outline: none; border-color: #2563eb; }
  .btn { padding: 9px 12px; border-radius: 8px; border: 0; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn.primary { background: #2563eb; color: #fff; }
  .btn.primary:disabled { opacity: .5; cursor: default; }
  .btn.ghost { background: transparent; color: #2563eb; padding: 6px; justify-self: start; }
  .btn.danger { background: transparent; color: #c0392b; border: 1px solid rgba(192,57,43,.35); justify-self: start; }
  .board { display: grid; gap: 2px; padding: 10px 12px; background: #f4f4f6; border-radius: 8px; }
  .board .b1 { font-weight: 600; }
  .muted { font-size: 12px; color: #6a6a70; }
  .host { font-family: ui-monospace, SFMono-Regular, monospace; }
  .msg { font-size: 12px; }
  .msg.err { color: #c0392b; }
  .msg.ok { color: #2ea043; }
  .spin { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(128,128,128,.3); border-top-color: #2563eb; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -2px; margin-right: 6px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-color-scheme: dark) {
    .wrap { color: #ececee; background: #1c1c1e; }
    .field input, .field select { background: #2c2c2e; color: #ececee; border-color: #3a3a3c; }
    .board { background: #2c2c2e; }
    .muted { color: #9a9aa0; }
  }
`;

function host(u?: string) {
  try { return u ? new URL(u).host : ''; } catch { return u || ''; }
}

export function Popup() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [boardUrl, setBoardUrl] = useState(DEFAULT_BOARD);
  const [user, setUser] = useState<BoardUser | undefined>();
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  // Returns true and moves to the connected view if the status says we're authenticated.
  function applyIfConnected(s?: Status): boolean {
    if (s?.connected) {
      setUser(s.user);
      if (s.boardUrl) setBoardUrl(s.boardUrl);
      setPhase('connected');
      return true;
    }
    return false;
  }

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'status' }, (s: Status) => {
      if (!applyIfConnected(s)) { if (s?.boardUrl) setBoardUrl(s.boardUrl); setPhase('disconnected'); }
    });
    return stopPoll;
  }, []);

  // While connecting, poll the SW: the approval tab steals focus and closes this popup, so the connect
  // callback is often orphaned — status polling is what reliably flips us to "connected".
  function startStatusPoll() {
    stopPoll();
    pollRef.current = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'status' }, (s: Status) => {
        if (applyIfConnected(s)) { stopPoll(); setBusy(false); setMsg({ t: 'Connected ✓', kind: 'ok' }); }
      });
    }, 1500);
  }

  function connect() {
    const url = boardUrl.trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(url)) { setMsg({ t: 'Board URL must start with http:// or https://', kind: 'err' }); return; }
    setBusy(true); setPhase('connecting'); setMsg(null);
    startStatusPoll();
    chrome.runtime.sendMessage({ type: 'connect', boardUrl: url }, (r) => {
      if (r?.ok) {
        chrome.runtime.sendMessage({ type: 'status' }, (s: Status) => {
          if (applyIfConnected(s)) { stopPoll(); setBusy(false); setMsg({ t: 'Connected ✓', kind: 'ok' }); }
        });
      } else if (r && r.error) {
        stopPoll(); setBusy(false); setPhase('disconnected');
        setMsg({ t: 'Connect failed: ' + r.error, kind: 'err' });
      }
    });
  }

  function cancel() { stopPoll(); setBusy(false); setPhase('disconnected'); setMsg(null); }

  function report() {
    if (!title.trim()) { setMsg({ t: 'Add a short title first', kind: 'err' }); return; }
    setBusy(true); setMsg({ t: 'Capturing…' });
    chrome.runtime.sendMessage({ type: 'report', title, severity }, (r) => {
      setBusy(false);
      if (r?.ok) { setMsg({ t: `Filed ${r.bug?.humanId ?? 'bug'}${r.warning ? ' · ' + r.warning : ''}`, kind: 'ok' }); setTitle(''); }
      else setMsg({ t: 'Report failed: ' + (r?.error || 'unknown'), kind: 'err' });
    });
  }

  function logout() {
    chrome.runtime.sendMessage({ type: 'disconnect' }, () => { setUser(undefined); setPhase('disconnected'); setMsg(null); });
  }

  return (
    <div className="wrap">
      <style>{css}</style>
      <div className="hd">
        <span className={'dot' + (phase === 'connected' ? ' on' : '')} />
        <span className="title">be10x Bug Capture</span>
      </div>
      <div className="body">
        {phase === 'loading' && <div className="muted">Loading…</div>}

        {phase === 'disconnected' && (
          <>
            <div className="field">
              <label>Board URL</label>
              <input value={boardUrl} onChange={(e) => setBoardUrl(e.target.value)} placeholder="https://your-board" spellCheck={false} autoCapitalize="off" />
            </div>
            <button className="btn primary" onClick={connect} disabled={busy}>Connect to board</button>
            <div className="muted">A tab will open to approve access — make sure you're signed into that board first.</div>
          </>
        )}

        {phase === 'connecting' && (
          <>
            <div><span className="spin" />Waiting for you to click <b>Authorize</b> in the tab that opened…</div>
            <div className="muted">Connecting to <span className="host">{host(boardUrl)}</span>. Updates automatically once you approve.</div>
            <button className="btn ghost" onClick={cancel}>Cancel</button>
          </>
        )}

        {phase === 'connected' && (
          <>
            <div className="board">
              <span className="b1">Connected{user?.displayName ? ` as ${user.displayName}` : ''}</span>
              <span className="muted host">{host(boardUrl)}</span>
            </div>
            <div className="field">
              <label>What's broken?</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Pay button does nothing" />
            </div>
            <div className="field">
              <label>Severity</label>
              <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="critical">critical</option>
              </select>
            </div>
            <button className="btn primary" onClick={report} disabled={busy}>{busy ? 'Filing…' : 'Report this page'}</button>
            <button className="btn danger" onClick={logout}>Log out / switch board</button>
          </>
        )}

        {msg && <div className={'msg' + (msg.kind ? ' ' + msg.kind : '')}>{msg.t}</div>}
      </div>
    </div>
  );
}

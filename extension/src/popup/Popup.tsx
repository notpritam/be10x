// ABOUTME: Popup UI — connect to a board (device auth) and report the current page as a bug.
// ABOUTME: All network egress runs in the service worker; this only sends messages and renders status.
import { useEffect, useState } from 'react';

const DEFAULT_BOARD = 'https://be10x.notpritam.in';

export function Popup() {
  const [boardUrl, setBoardUrl] = useState(DEFAULT_BOARD);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('medium');

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'status' }, (s) => {
      if (s?.connected) { setConnected(true); if (s.boardUrl) setBoardUrl(s.boardUrl); }
    });
  }, []);

  function connect() {
    setBusy(true); setMsg('Opening approval tab…');
    chrome.runtime.sendMessage({ type: 'connect', boardUrl }, (r) => {
      setBusy(false);
      if (r?.ok) { setConnected(true); setMsg('Connected ✓'); }
      else setMsg('Connect failed: ' + (r?.error || 'unknown'));
    });
  }

  function report() {
    setBusy(true); setMsg('Capturing…');
    chrome.runtime.sendMessage({ type: 'report', title, severity }, (r) => {
      setBusy(false);
      if (r?.ok) setMsg(`Filed ${r.bug?.humanId ?? r.bug?.id ?? 'bug'}${r.warning ? ' — ' + r.warning : ''}`);
      else setMsg('Report failed: ' + (r?.error || 'unknown'));
    });
  }

  return (
    <div style={{ padding: 16, display: 'grid', gap: 8 }}>
      <strong>be10x Bug Capture</strong>
      {connected ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ color: 'green', fontSize: 12 }}>Connected to {boardUrl}</div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's broken?" />
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="critical">critical</option>
          </select>
          <button onClick={report} disabled={busy}>{busy ? 'Filing…' : 'Report this page'}</button>
        </div>
      ) : (
        <>
          <input value={boardUrl} onChange={(e) => setBoardUrl(e.target.value)} placeholder="https://your-board" />
          <button onClick={connect} disabled={busy}>{busy ? 'Connecting…' : 'Connect to board'}</button>
        </>
      )}
      {msg && <div style={{ fontSize: 12, opacity: 0.8 }}>{msg}</div>}
    </div>
  );
}

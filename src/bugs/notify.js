// ABOUTME: Optional new-bug notification — POSTs a compact, Slack-compatible payload to a configured webhook
// ABOUTME: when a bug is filed. Best-effort + fire-and-forget: a webhook failure never affects bug ingest.
// ABOUTME: Inert unless GFA_BUG_WEBHOOK is set. No credentials/auth in the payload — just the triage header.

const SEV_EMOJI = { critical: '🚨', high: '🔴', medium: '🐞', low: '🐛' };

// Build the notification body. Slack incoming webhooks render `text` (mrkdwn) and ignore the extra `bug`
// object; a generic receiver gets the structured fields too. Pure.
export function buildBugNotification(bug, { boardOrigin } = {}) {
  const emoji = SEV_EMOJI[bug.severity] || '🐞';
  const text =
    `${emoji} New bug *${bug.humanId}* (${bug.severity}): ${bug.title}\n${bug.pageUrl}` +
    (boardOrigin ? `\n${boardOrigin}` : '');
  return {
    text,
    bug: {
      id: bug.id,
      humanId: bug.humanId,
      title: bug.title,
      severity: bug.severity,
      status: bug.status,
      pageUrl: bug.pageUrl,
    },
  };
}

// Fire the webhook if one is configured. Returns { sent } — never throws. Without a webhook it does NOT fetch.
export async function notifyBugFiled(bug, opts = {}) {
  const webhook = opts.webhook ?? process.env.GFA_BUG_WEBHOOK;
  if (!webhook) return { sent: false };
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    await doFetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBugNotification(bug, { boardOrigin: opts.boardOrigin })),
    });
    return { sent: true };
  } catch {
    return { sent: false }; // best-effort — a bad/unreachable webhook must never break bug ingest
  }
}

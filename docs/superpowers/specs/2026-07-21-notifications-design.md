# Notifications — feed + connector device delivery + worklist truth (design)

**Date:** 2026-07-21 · **Owner:** pritam@emergent.sh · **Status:** approved, building

Close the #1 gap the human-in-the-loop analysis found (`docs/research/2026-07-21-human-in-the-loop-gaps.md`):
be10x routes work to the right machine but never **tells the right person**. This bundles the notification
backbone (#1) + the in-app worklist truth (#2).

## Decisions
- **Events (this slice):** `assigned`, `review_requested`, `input_needed`, `changes_requested`. @-mentions deferred.
- **Delivery:** the always-on **connector** shows native OS notifications. On by default + a toggle.
- **Never notify yourself** for your own action.

## A. Notifications feed (board)

**Table** `notifications` (schema.sql): `id TEXT PK`, `user_id TEXT NOT NULL REFERENCES users(id)`,
`kind TEXT NOT NULL`, `task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE`, `title TEXT NOT NULL`,
`body TEXT`, `created_at INTEGER`, `seen_at INTEGER`. The table's `rowid` is the monotonic **seq**.

**Core** `src/notify/notify.js`:
- `notify(db, userId, kind, { taskId, title, body, actorId })` → inserts a row and returns it; **no-op
  (returns null) when `userId` is falsy or `userId === actorId`** (don't notify yourself).
- `listNotificationsSince(db, userId, sinceSeq, limit=50)` → rows with `rowid > sinceSeq`, oldest→newest.
- `listNotificationsForUser(db, userId, limit=30)` → newest-first, for the web bell.
- `unseenCount(db, userId)` / `markAllSeen(db, userId, now)`.

**Emit points** (each already knows who must act; pass `actorId` so self-actions skip):
- `src/tasks/tasks.js setTaskAssignee` → `notify(db, assigneeId, 'assigned', {taskId, title, body, actorId})`.
- `src/reviews/reviews.js requestReview` → `notify(db, reviewerId, 'review_requested', {…, actorId})`.
- `src/tasks/input_requests.js requestInput` → `notify(db, task.assigneeId ?? task.ownerId, 'input_needed', {…, actorId})`.
- `src/reviews/reviews.js submitReview` (changes_requested) → `notify(db, task.assigneeId ?? task.ownerId,
  'changes_requested', {…, actorId})`.
Title/body are short human strings (`"GFA-12 assigned to you"`, task title as body). Best-effort: a notify
failure never breaks the mutation (wrap in try/catch at call sites is unnecessary — notify itself never throws).

## B. Connector device delivery

**`src/connect/device-notify.js`** (dependency-free):
- `notifyCommand(platform, { title, body })` → `{ cmd, args }` (pure, testable): darwin →
  `osascript -e 'display notification …'`; linux → `notify-send`; win32 → `powershell` toast. Unknown → null.
- `showDeviceNotification({title, body}, { platform, spawn })` → runs it; never throws.

**Endpoint** (Bearer, agent route) `GET /api/agent/notifications?since=<seq>` →
`{ notifications: listNotificationsSince(db, auth.userId, since) }`.

**Watermark** `~/.be10x/notify-state.json` `{ enabled: true, lastSeq: <n> }` (`src/connect/notify-state.js`:
load/save, default `{enabled:true, lastSeq:0}`).

**Poll** — in the connector loop (bin `cmdConnect` / `connectLoop`), each cycle: if `enabled`, GET
`?since=lastSeq`; for each row show a device notification; set `lastSeq = max(rowid)` and save. Exactly-once,
and it flushes everything queued while the machine was offline. Failures are logged, never fatal.

**CLI** `be10x notify [on|off|test|status]` (`bin/be10x.js`): flips `enabled`, or fires a sample
notification to confirm OS permission (macOS/Windows prompt on first fire).

## C. In-app worklist truth (web)

- **Per-user "Needs you"** — `app-store.tsx`: filter/count become `status === "needs_input" && (assigneeId ===
  me || ownerId === me)` (was every visible needs_input task).
- **"Awaiting me" view** — a new sidebar view + count: union of (needs_input where I'm assignee/owner) ∪
  (plan_review where I'm the reviewer). One inbox for "what needs *me*".
- **Hide review actions from non-reviewers** — `DeepDivePanel.tsx:249`: render `ReviewActions` only when
  `awaitsReview(task, me)`; else a read-only "Awaiting review by {reviewer}" line.
- **Bell** — top bar bell with unread count from `GET /api/notifications` (session): `{ notifications, unseen }`;
  `POST /api/notifications/seen` marks all seen. Dropdown lists recent; clicking one opens the task.
  `web/src/components/shell/NotificationsBell.tsx` + `api.notifications()` / `api.markNotificationsSeen()`.

## D. Testing (TDD)
- `notify.js` pure: skips null/self, inserts, `listSince`/`unseenCount`/`markAllSeen`.
- Emit: assigning/requesting-review/requesting-input/changes each create a row for the right user, and
  self-actions create none.
- `GET /api/agent/notifications?since` returns only newer rows for the Bearer user; 401 without a token.
- `device-notify` `notifyCommand` per platform (pure).
- web/HTTP: `GET /api/notifications` + `POST /api/notifications/seen`; worklist selectors (per-user Needs you,
  Awaiting me).

## E. Out of scope (later slices)
@-mentions, email/web-push, approval **enforcement** (slice #3), stale-request reminders, N-of-M reviewers,
notification deep-link actions (approve-from-notification).

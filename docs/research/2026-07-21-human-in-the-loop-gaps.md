# Human-in-the-loop gaps: input requests, review/approval, notifications (2026-07-21)

Deep-dive across three flows in be10x. One dominant theme + two integrity clusters. Gaps cite real
file:line. Design direction (from the product owner 2026-07-21): **the connector service delivers native
device notifications for anything the user is tagged in.**

## The picture in one line
be10x can *route* work to the right machine, but it can't **tell the right person** — and it doesn't
**enforce** the approval it implies. Everything sits in a queue until a human happens to open the right tab.

---

## THEME 1 (dominant): Nobody gets told. Work waits on accidental attention.

- **No notification anywhere on task events.** The only outbound signal in the whole server is an optional
  bug→Slack webhook (`src/bugs/notify.js`, wired at `src/http/server.js:986`). `requestInput`
  (`src/tasks/input_requests.js:7-17`), `requestReview` (`src/reviews/reviews.js:7-17`), and
  `setTaskAssignee` (`src/tasks/tasks.js:211-216`) each write a row + event and fire **zero** alerts.
- **"Needs you" is a lie about ownership** — it's `t.status === "needs_input"` for *every* visible task
  (`web/src/state/app-store.tsx:43-44,428`), not scoped to the assignee. Whole team sees it; nobody owns it.
- **No "Assigned to me / Awaiting me" surface** at all (`Sidebar.tsx` views: All / Personal / Needs you /
  Review queue / Bugs). Assignment drives routing, not awareness.
- **Non-reviewers see Approve / Request-changes buttons** that always fail (`ReviewActions` renders for any
  viewer of a `plan_review` task, `DeepDivePanel.tsx:249`; server rejects with FORBIDDEN, `server.js:572`).
- **No off-app / cross-device alerting**; freshness capped at the 4s board poll / 3s detail poll. No push,
  no email, no service-worker handler.

**→ Backbone fix (Theme 1): the notification system, delivered by the connector.**

---

## Notification backbone — design

The connector already runs always-on on each teammate's machine and polls the board (`be10x connect` /
`service`). Make it the delivery channel.

1. **Board: a notifications feed.** A `notifications` table `{id, seq (monotonic, per-user), userId, kind
   (assigned|review_requested|input_needed|changes_requested|mention|done), taskId, title, body, createdAt,
   seenAt}`. Emit a row at the three chokepoints that already know *who must act*:
   - `input_requests.js:15` (→ needs_input) → notify `assigneeId ?? ownerId`
   - `reviews.js:11-15` (requestReview) → notify `reviewerId`
   - `tasks.js:214-215` (setTaskAssignee) → notify the new `assigneeId`
   - and `submitReview` changes_requested → notify the task's assignee/author.
2. **Bearer endpoint for the connector:** `GET /api/agent/notifications?since=<seq>` → the token user's
   notifications newer than a watermark (the Orca replay pattern: idempotent, exactly-once, "while you were
   offline"). `POST /api/agent/notifications/ack {seq}` advances the server-side seen marker.
3. **Connector shows OS notifications.** In the poll loop, fetch `since=<lastSeenSeq>`; for each, show a
   native notification (macOS `osascript -e 'display notification'` / `node-notifier`, Linux `notify-send`,
   Windows toast), then persist the new watermark locally. Request notification permission on first run
   (`be10x service install` / first `connect`), with a `be10x notify test` command.
4. **In-app parity:** a bell/unread count from the same feed; `document.title` + favicon badge when the tab
   is backgrounded.
5. **@-mentions:** parse `@user` in comments → a `mention` notification to that user.

Ties directly into the roadmap's presence/activity work (`docs/research/2026-07-20-orca-teardown-and-be10x-roadmap.md:155-171`):
presence says *who's reachable*; this says *what needs them*.

**In-app worklist fixes that pair with it:** scope "Needs you" to `assignee/owner === me`
(`app-store.tsx:43`); add an **"Awaiting me"** inbox (assigned-to-me + my reviews + my input requests);
hide `ReviewActions` unless `task.reviewerId === user.id` (use the existing `awaitsReview` helper,
`app-store.tsx:33`).

---

## THEME 2: Approval isn't actually enforced (review integrity)

- **Review is optional/skippable.** `plan_review → ready_to_work` is a plain transition
  (`src/tasks/lifecycle.js:22`) with no check that an approved `reviews` row exists; `backlog →
  ready_to_work` and `gfa_mark_ready` (`tools.js:208-218`) bypass the plan gate entirely; CLI enqueues
  `execute` directly. The "human approves before implement" guarantee doesn't hold. → gate
  `plan_review → ready_to_work` on an approved review for the current plan version + a per-task/team
  "review required" policy flag.
- **Self-review is the default.** `gfa_submit_plan` defaults reviewer to `task.ownerId` (`tools.js:204`);
  submit only checks `reviewerId === user.id` (`server.js:572`), never that reviewer ≠ author. → forbid
  self-approve for team tasks (or require an explicit ack).
- **Re-review silently re-routes to the owner.** After changes, a re-submit without `reviewerId` re-defaults
  to owner (`tools.js:204`), overwriting the teammate reviewer. → default to the *existing* `reviewer_id`.
- **No implementation/output approval before done.** `verify` is read-only; `verifying → done` is an
  ordinary transition (`lifecycle.js:26`) — no second-party approval of the diff. → extend reviews to a
  second gate on `verifying` (an `implementation` review kind, reviewer-only `verifying → done`).
- **Reviewer's note is invisible + reviews table is write-only.** The note lives only in the `reviews` row /
  event payload (`reviews.js:24-32`); `listReviews` is never called by any endpoint; the feed shows
  "requested changes" without the text. → surface the note in the activity feed + `GET /api/tasks/:id/reviews`.
- **Share-link review verdicts are dead-ends.** `POST /api/share/:token/review` only appends a comment
  (`server.js:673-679`) — no transition, no wake; the public page even offers a `rejected` verdict that maps
  to nothing. → route share reviews through `submitReview` + enqueue the wake, or drop `rejected`.
- **Reviewer membership unvalidated** (API can tag a reviewer who can't see the task, `reviews.js:10`);
  **no multi-reviewer / N-of-M approvals** (single `reviewer_id` column).

---

## THEME 3: Input requests are fragile

- **No timeout / stuck-detection.** No reaper or deadline for an unanswered `needs_input`; a forgotten
  question is a silently dead task (orphan recovery only fires on a dead *process*, `runner.js:315-334`).
  → age-based sweep that re-notifies on stale open requests.
- **Asking during planning is silent.** `requestInput` only flips to `needs_input` from `in_progress`
  (`input_requests.js:15`), but the planner directive tells the agent to ask *during plan mode*
  (`executor.js:75`) — so the row is open with no badge and never appears in "Needs you". → surface a
  needs-input signal for any active status.
- **One open question at a time; flat choices.** `getOpenInputRequest` returns a single row
  (`input_requests.js:43-48`); `choices` is a flat `string[]` (`tools.js:285`) — no per-option
  descriptions, no multi-select, no AskUserQuestion-style grouped options. → render all open requests;
  enrich to `{label, description}[]` + multi-question.
- **No explicit cancel / re-ask** (cancellation only as a side effect of `setPlan`, `tasks.js:172-179`).
- **Question rendered as plain text** (`InputRequestPanel.tsx:51`) — no markdown; no "who's being asked"; no
  Q&A history. **Answer not validated** against `choices` server-side when `allow_custom=0`.

---

## Recommended build order

1. **P0 — Notification backbone + connector device notifications** (Theme 1). Feed table + emit at the 3
   chokepoints + `GET /api/agent/notifications` + connector OS-notify + watermark. Delivers the core value:
   the right person is told, on their device, for anything they're tagged in.
2. **P0 — In-app worklist truth** (Theme 1 pair): per-user "Needs you", an "Awaiting me" inbox, hide
   approve buttons from non-reviewers. Small, high-clarity.
3. **P1 — Enforce approval** (Theme 2 core): gate `plan_review → ready_to_work` on an approval + preserve
   the reviewer on re-review + surface the review note. Makes the approval real.
4. **P1 — Input-request robustness** (Theme 3): needs-input signal in any status + stale-request re-notify +
   markdown question + server-side choice validation.
5. **P2**: implementation/output approval gate, multi-reviewer/N-of-M, share-link review wiring, structured
   multi-question input.

Each P0/P1 is a small, testable slice; the notification feed (1) is the substrate the rest hang off.

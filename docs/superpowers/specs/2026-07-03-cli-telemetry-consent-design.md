# CLI telemetry + consent — design

Date: 2026-07-03
Status: approved, implementing

## Why

be10x is moving from "internal team tool" to a publicly-installable CLI. There's currently zero
visibility into how it's used, and zero consent flow of any kind (confirmed by a full-codebase
audit before this design: no analytics/telemetry/crash-reporting infrastructure exists anywhere,
no ToS/consent screen exists, no analytics dependency in any package.json).

## Decisions (in order they were settled)

1. **Data scope**: a full action/state log, not just anonymous usage counters — the log can
   include actual task/plan content, not only metadata.
2. **Content inclusion is opt-in, not opt-out.** be10x's own landing page promises "your code
   never leaves your machine." Sending content contradicts that promise for whoever turns this
   on, so it must be a deliberate choice, not a default — the promise stays true out of the box.
3. **Destination**: be10x's own server, not a third-party vendor (PostHog/Sentry/etc.) — no new
   vendor dependency, and task content never leaves infrastructure the maintainers control.
4. **Scope of "own server"**: centralized, not per-deployment. Every `be10x` CLI install,
   anywhere — including future third-party self-hosted boards once the project is public —
   reports to one endpoint the be10x maintainers control, separate from whatever board a given
   install uses for its actual task orchestration.

## What gets recorded

Two layers, both gated by the same consent flag:

- **CLI command events** (`cli_command`): which command ran (`link`, `connect`, `login`,
  `work`, `service`, …), whether it succeeded, duration. No argument values (an `--email` or
  `--project` value isn't "task content" and has no reason to be captured).
- **Task-execution events** (`task_run`): recorded specifically where the CLI has direct access
  to task substance — the `work`/`connect` execution loops, right before/after an agent run.
  Includes task id, human id, title, `content`, `plan`, the run mode (plan/execute/verify), and
  the outcome. This is where "state or actions taken" with real content lives; nothing outside
  these two event kinds is captured.

## Consent flow

- First `be10x` invocation of any kind (bare, `help`, or any command except `telemetry` itself)
  where no decision is on record yet, AND stdin/stdout are a TTY, shows one prompt:
  `Send task activity (including task/plan content) to help improve be10x? [y/N]`. Default on
  Enter/non-answer is **no**.
- Non-interactive contexts (CI, piped input, no TTY) never prompt and default to **off** — never
  block or alter automation.
- The decision persists in `~/.be10x/telemetry.json` (`{ installId, enabled, decidedAt }`), a
  new file — kept separate from `~/.be10x/connect.json` because telemetry applies to CLI usage
  generally, not only to the `connect`-a-hosted-board flow.
- `be10x telemetry status|on|off` changes it anytime, no re-prompt.
- `GFA_TELEMETRY=0`/`1` env var overrides the effective state for that invocation only (doesn't
  touch the persisted file) — standard escape hatch for scripting/CI.

## Transport

- Events append to a local queue file (`~/.be10x/telemetry-queue.ndjson`) only when enabled.
- A best-effort flush attempts to POST queued events to `POST /api/telemetry` on the central
  server after each command and opportunistically on the next invocation if a prior flush
  failed. Failures are silent and never affect the CLI's exit code or output (unless
  `BE10X_DEBUG` is set).
- Batches are capped (event count and per-event content length) on both the client (bounds local
  disk growth) and the server (defense in depth against a malformed or hostile sender, since the
  endpoint is intentionally unauthenticated).
- Identified by a random `installId` (`crypto.randomUUID()`), generated once, stored locally.
  Never an email or account id — the server has no way to tie an event to a specific person
  unless the task content itself happens to contain one.

## Storage

New `telemetry_events` table on the board's existing SQLite DB (no new service):
`id, install_id, event, cli_version, os, node_version, payload_json, occurred_at, received_at`.

## Explicit non-goals

- Not building a dashboard/viewer for this data yet — out of scope for this slice.
- Not integrating a third-party analytics vendor.
- Not a substitute for a real privacy policy / legal review. The in-CLI disclosure text is a
  good-faith plain-language summary, not legal copy — real review is recommended before this
  reaches users outside the maintainers' own team, since collecting task content from the
  public raises real privacy-law questions (GDPR-style) that a design doc can't resolve.

## Testing

Unit coverage for: config load/save round-trip, effective-enabled resolution (env override
beats stored state), queue record/flush (success clears sent lines, failure leaves them queued,
batch/content caps enforced), the new endpoint (accepts valid batches, rejects malformed/
oversized ones, requires no auth), and the `telemetry` CLI subcommand.

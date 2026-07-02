---
name: be10x-adopt
description: Use when the human asks to move, adopt, push, or send the work in the current terminal/CLI session onto the be10x board ("the 10x board" / "10x controller") — turns loose session work into a durable, controllable board task at the right project and phase, via the be10x MCP.
---

# Adopt this session onto the be10x board

The human is working with you in a terminal/CLI session and wants this work to become a **durable task on the be10x board**, so they (and teammates) can see and control it from there. You do this in ONE call to the be10x MCP tool `gfa_import_task`. Sessions are disposable; the board is where state lives.

## Preconditions

You need the be10x MCP tools (prefixed `gfa_`). If `gfa_import_task` is unavailable, the repo isn't linked — tell the human to run `be10x link` in this repo (and `be10x serve` so the board is up), then retry. Do not fabricate a board entry any other way.

## Steps

1. **Judge the phase — this decides how much you capture.** Pick the ONE phase that matches where the work actually is:
   - `idea` — barely started / just a request → capture only a **title** and one-line **summary**.
   - `researching` — you've been investigating → add a **research** payload (root cause, what you've found, sources).
   - `plan_review` — you have a concrete plan the human should approve → include the **plan** (rich HTML preferred, else markdown / `{ steps, diagram }`). Lands awaiting their review.
   - `ready` — plan is settled, implementation hasn't started → include the plan; the task lands ready to work.
   - `in_progress` — you're mid-implementation → include the plan, any **artifacts** (findings/diagrams), and any **refs** (branch/PR) already produced.
2. **Do NOT over-capture.** Attach only what fits the phase (an idea needs no plan; early research needs no artifacts). It depends on the phase — that's the point.
3. **Prefer showing over telling.** Convey findings as `artifacts` (RCA / diagram / finding / suggestion), with **HTML** content where you can — the board renders it safely. This is how the human grasps the work at a glance.
4. **Pick the project.** Use the current repo's project key (from `be10x link`) as `projectKey` unless the human names another. Omit it only for a genuinely personal task. If you're unsure which project, ask one short question.
5. **Handoff or not.** If the human wants the board's agent to CONTINUE the work, pass `handoff: true`. If they want to review/steer it themselves first, omit it (default).
6. **Call `gfa_import_task`** with: `title`, `phase`, `projectKey`, the type (`code-issue` for a bug/defect, else `general`), `summary` or `symptom`, and whatever of `plan` / `research` / `artifacts` / `refs` the phase warrants.
7. **Report back** the task's human id, status, and its board path (`boardPath` in the result), e.g. "Adopted as GFA-012 (plan_review) — open /t/…/full on your board." Then stop; the human drives it from the board.

## Notes

- One call does it all: `gfa_import_task` creates the task, files it in the project, attaches the payloads, and walks the lifecycle to the phase — you don't call `gfa_create_task` / `gfa_plan_task` / `gfa_post_artifact` separately for an adopt.
- After adoption, control moves to the board. Don't keep working locally unless the human asks — the board (or its agent, if you handed off) takes it from here.

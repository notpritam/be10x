# Per-step context flow (locked design)

**Status:** locked 2026-07-02, not yet implemented. Ship the basic version described here; template/scriptable version comes later (see "Later"). This document is the source of truth for the approach.

## Goal

Give each lifecycle step transition an explicit **context policy**: when we move from one step to the next (e.g. plan → implement), decide whether the next agent **resumes** the prior Claude session (full live context) or starts a **fresh session seeded only with a distilled artifact** (clean slate). The clear goal is: once the plan is final, the implement step starts from *just the plan*, not the whole planning transcript.

This refines be10x's principle — *"sessions disposable, state durable"* — by making the context **boundary** a first-class, per-transition decision.

## The two policies (a third comes later)

- **`resume`** — continue the same Claude session (`--resume <session_id>`), full live context. Right for tight iteration *inside* a step (e.g. revise-within-plan_review).
- **`fresh-from-artifact`** — start a **new** session seeded only with a declared **handoff payload**, dropping the prior transcript. Right at step *boundaries*, especially plan → implement.
- **`summarize`** *(later)* — for boundaries where the artifact isn't self-sufficient (e.g. research → review): run a cheap distill pass first and seed the new session with that brief. Not needed for plan → implement, because the plan **is** the compaction.

## Default policy map (v1)

| Transition | Policy |
|---|---|
| backlog → researching | fresh (plan mode, already fresh today) |
| within researching / plan_review (revise, comments) | **resume** |
| **plan_review → ready_to_work / in_progress (implement)** | **fresh-from-artifact** |
| input_answer, follow_up within a step | resume |

Today the executor does the *opposite* at the key edge: `wantResume = mode !== 'plan'`, so **execute currently resumes the planning session**. The core change is to make execute use `fresh-from-artifact` instead.

## Handoff payload for plan → implement

Seed the fresh implement session with:
- the **finalized plan version** (from the `plan_versions` table — the plan is already durable + addressable),
- the **original task ask** (content.symptom/summary/…),
- any **locked decisions** (answered input_requests / review notes).

**Not** the raw planning transcript and **not** the research scratchpad. (Plan-only can under-specify the *why* — that's why the ask + decisions ride along.)

## The choice, surfaced at the transition

Per the user: before moving to the next step, **offer the choice** at that point — "resume the implement session" vs "clear context and start fresh from the plan." Default = fresh-from-artifact at plan → implement, but the human can pick per task at the boundary (e.g. a control on the plan-approval / move-to-work action). Later this becomes part of a templated, scriptable flow.

## Session lineage (not resume)

The previous session stays **archived and referenceable** (its run row + session id persist for audit/debug) but is **never injected** into the new agent. The new run records `seededFromVersion` (the plan version id) + `parentRun` for lineage.

## Why this also unlocks forking / variants (separate, later)

Because the handoff is *an artifact + a fresh session in its own worktree*, forking a task into N variants after plan approval is trivial: N children, each seeded from the same approved plan version, each in its own worktree, run independently, compared. Forking is clean **only because** we chose fresh-from-artifact over resume. (Variant/versioning UI is a separate follow-on.)

## Implementation notes (when we build it)

- Add a `contextPolicy` (`resume | fresh | summarize`) resolved per wake/transition, replacing the `mode !== 'plan'` heuristic in `makeClaudeExecutor` (`src/executor/executor.js`).
- On `fresh`, do NOT resume `getLatestRunForTask().sessionId`; build the prompt from the handoff payload (plan version + ask + decisions) in `buildPrompt`.
- Persist `seededFromVersion` + `parentRun` on the run row.
- Surface the boundary choice on the plan-approval / move-to-work UI (default fresh; toggle to resume).

## Later

Template the per-step policy as a saved, shareable **flow/script** (the scriptable workflow-builder): each step-block declares `{adapter/model, directive, contextPolicy, extract-contract, gate}`. This context-flow is the substrate that flow exposes. Multi-provider handoffs (e.g. Gemini research → Claude review → Claude implement) are the same extract-contract generalized.

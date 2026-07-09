# QA→Dev Bug-Capture + Session-Replay — Competitive Research (2026-07-10)

Scope: 17 tools, framed against what we already have (screenshot, DOM snapshot, network capture **with bodies**, identity, rrweb recorder with a **rolling buffer** = retroactive replay, markers, visits, server session storage + rrweb-player). Claims are cited to fetched vendor pages/docs.

## 0. Headline reads (act on these)

- **Our lane is narrow and winnable.** Only three tools do the same thing — *click-to-file + rrweb-style DOM replay + retroactive buffer*: **Bird Eats Bug** (BrowserStack), **OpenReplay Spot**, **Shake** (mobile-first). Jam's replay is video-based (not DOM); Marker's is a capped ~3-min action replay. The always-on SDK platforms (LogRocket/FullStory/Sentry/Zipy) are a heavier "instrument-first" model and mostly have **no click-to-file** path.
- **We already own the hard 80%** — rrweb DOM replay + retroactive rolling buffer + network capture + server-side session storage + player. Most competitor advantages are last-mile capture polish + handoff + enterprise plumbing (LOW–MED effort on our pipeline).
- **Two real wedges:** (a) **network request/response bodies by default, with redaction** — Sentry/FullStory gate bodies behind allowlists; QA is exactly the case that needs them (we already capture bodies in our net-hook). (b) **Self-hostable + open rrweb format** — Jam/Marker/BugHerd are cloud-only; we already run our own server.
- **Biggest gap in our current build: console-log capture.** Every serious tool has it; rrweb ships an official plugin. #1 quick win.
- **The handoff feature that sells: one-click issue creation with 2-way sync** (Marker.io's Jira moat; Sentry, Shake-Linear also 2-way).

## 1. Landscape — capture (Y=yes · ~=partial/gated · —=no)

| Tool | Annot shot | Video | Retro buffer | rrweb-style DOM replay | Console | Network **+bodies** | Auto repro | PII mask | Error auto-capture | Click-to-file |
|---|---|---|---|---|---|---|---|---|---|---|
| Jam.dev | Y | Y | **Y** | — (video) | Y | **Y (all bodies)** | Y | Y | ~ | Y |
| Marker.io | Y | Y | Y (~3min) | ~ (capped) | Y | ~ | ~ | Y | ~ | Y (**2-way**) |
| BugHerd | Y | Y | — | — (offloads) | ~ | — | — | — | — | Y |
| Bird Eats Bug | Y | Y | **Y** | **Y** | Y | **Y (≤1MB)** | Y | Y | **Y** | Y |
| Usersnap | Y | Y | — | — | Y | ~ | ~ | Y | ~ | Y (**2-way**) |
| Disbug | Y | Y | — | ~ | Y | ~ | Y | — | — | Y |
| Ybug | Y | ~ | — | — | Y | ~ | — | Y | — | Y |
| Shake | Y | Y | **Y (15s)** | ~ | Y | **Y** | Y | Y | **Y** | Y |
| Zipy | — | —(DOM) | ~ | **Y** | Y | **Y** | Y | Y | Y | — |
| LogRocket | — | —(DOM) | Y | Y (proprietary) | Y | **Y (h+b)** | Y (AI) | ~ | Y | — (SDK) |
| FullStory | — | — | Y | Y (proprietary) | Y | ~ (allowlist) | Y | **Y (default)** | ~ | — (SDK) |
| Sentry Replay | — | — | ~ (on-error) | **Y (rrweb)** | Y | ~ (opt-in) | Y | **Y (default)** | **Y** | — (SDK+widget) |
| OpenReplay Spot | ~ | Y | Y | Y | Y | **Y (h+b)** | Y | Y | Y | **Y (ext)** |

Direct competitive set (capture-all + bodies + DOM replay + click-to-file): **Bird, Shake, OpenReplay Spot**.

## 2. Best features to steal — prioritized (effort is *for us*, on our rrweb+server+player pipeline)

**Tier 1 — quick wins (LOW effort):**
1. **Console-log capture** — intercept console + unhandledrejection → panel synced to the replay. rrweb `@rrweb/rrweb-plugin-console-record` is drop-in. *Our biggest gap.*
2. **Device/browser/OS/viewport/env metadata auto-attach** — snapshot navigator/screen/URL/tz at capture. Kills "which browser?".
3. **Shareable public/tokenized replay link** — signed link → login-less viewer page. Jam's entire GTM. We already have session_key + routes + player; add a tokenized read route.

**Tier 2 — differentiators (MED effort):**
4. **Network bodies + redaction** — bodies capped by size/content-type behind a sanitizer allow/deny list. Our clearest wedge (Sentry/FullStory gate bodies). *(We already keep bodies — add the redaction layer.)*
5. **Error/crash auto-capture** — global onerror/unhandledrejection (+ optional 5xx) auto-flush the rolling buffer. Turns manual tool → always-on net.
6. **Auto repro-step trail** — synthesize rrweb interactions into numbered "steps to reproduce". AI-summary upsell.
7. **Screenshot annotation (arrows/boxes/blur)** — canvas overlay in the widget; blur doubles as PII control.

**Tier 3 — enterprise-gated:**
8. **PII redaction default-on** — rrweb mask/block/ignore + network sanitizers + screenshot blur, masked *before data leaves the browser*. Sentry/FullStory's "private by default" is the enterprise bar.

**Optional upside:**
9. **AI bug summary/title** — LLM turns replay+console+network into title/repro/likely-cause (Jam, LogRocket Galileo, Zipy).

**rrweb reality check:** core gives DOM replay + masking + console plugin free, but the network-record plugin is newer and captures no bodies by default (allowlist) — budget engineering on #4; canvas/cross-origin iframes are known limits.

## 3. Dev-integration priorities (QA→dev handoff)
1. **Jira — with 2-way sync** (build first; the market exists to feed Jira). 2. **Linear** (2-way). 3. **GitHub/GitLab Issues**. 4. **Slack/Teams** (notify + replay link). 5. **Azure DevOps**. 6. **Webhooks/REST API** (covers ClickUp/Asana/Trello/Notion long-tail). The **2-way sync capability matters more than integration count** — it closes the loop so the reporter learns when it's fixed.

## 4. Enterprise must-haves
- **SSO/SAML** (table stakes) · **SCIM** (differentiator — only Sentry + OpenReplay-EE) · **RBAC** · **PII redaction client-side** (Sentry/FullStory lead) · **EU data residency** · **retention controls** · **self-hosting** (our wedge vs Jam/Marker/BugHerd) · **SOC 2 Type II** (table stakes) · **audit logs** · **HIPAA/BAA** (LogRocket, Sentry only).
- Position none fully occupy: **"the click-to-file QA tool with real enterprise posture — self-hostable, SSO+SCIM, mask-before-it-leaves-the-browser."** The QA widgets can't self-host; Sentry/OpenReplay aren't click-to-file QA tools.

## 5. "Adopt next" — top 8 by impact-for-effort
1. Console-log capture — LOW/HIGH — **do first**
2. Device/env metadata — LOW/HIGH
3. Shareable public replay link — LOW–MED/HIGH
4. Error/crash auto-capture — MED/HIGH
5. Network bodies + redaction — MED/HIGH
6. One-click Jira/Linear/GitHub + 2-way sync — MED–HIGH/HIGH
7. Auto repro-step trail — MED/MED–HIGH
8. Screenshot annotation + blur — MED/MED

**Enterprise track (parallel, longer lead):** SSO/SAML → default-on PII masking → SOC 2 Type II → self-host packaging → SCIM/audit logs. Prioritize self-host — our closest QA competitors structurally can't match it.

_Sources: jam.dev, marker.io, bugherd.com, birdeatsbug.com, usersnap.com, disbug.io, ybug.io, shakebugs.com, zipy.ai, docs.logrocket.com, fullstory.com/trust, sentry.io + docs.sentry.io, openreplay.com + docs.openreplay.com, rrweb.io — vendor pages/docs as of 2026-07-10._

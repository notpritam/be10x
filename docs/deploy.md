# Deploy be10x to Render — go live

This is the full runbook to put the be10x **board** on the internet and get your team working on it.

**What you're deploying:** the board only — web UI + REST API + SQLite. **The Claude agent does _not_ run here.** Each teammate runs it on their **own** machine with `be10x connect` (their repos, their Claude login). So the server needs **no** Claude API key, and it stays cheap and simple: it just holds state and coordinates.

```
   Render (this deploy)                 each teammate's laptop
   ┌─────────────────────┐   HTTPS      ┌──────────────────────────┐
   │ board · UI · API     │◀───+token───▶│ be10x connect → claude   │
   │ SQLite on /data disk │              │ in their own repo        │
   └─────────────────────┘              └──────────────────────────┘
```

---

## 0. Prerequisites

- The repo is pushed to GitHub (`notpritam/be10x`) — ✅ done.
- A **Render** account (render.com), connected to your GitHub.
- A **paid instance** — a persistent disk (where the DB lives) requires **Starter or above**. The **free tier has no disk**, so the board's data would be wiped on every restart. Starter is a few dollars/month.
- Optional: a domain you control (e.g. `notpritam.in`) if you want `be10x.notpritam.in` instead of the default `*.onrender.com` URL.

---

## 1. Deploy — Option A: Blueprint (recommended)

The repo ships a `render.yaml`, so Render can provision everything in one shot.

1. Render Dashboard → **New +** → **Blueprint**.
2. Pick the **`notpritam/be10x`** repo. Render finds `render.yaml` and shows a plan: one web service `be10x` + one 1 GB disk `be10x-data` at `/data`.
3. Confirm the **instance type is a paid plan** (Starter+) — required for the disk.
4. Click **Apply**. Render builds the Docker image and boots the service (first build ~3–5 min).
5. When it goes green, open the service URL: `https://be10x-XXXX.onrender.com`.

That's it — skip to **§3**.

## 1. Deploy — Option B: Manual web service

If you'd rather click through it (or the blueprint errors):

1. Render Dashboard → **New +** → **Web Service** → pick `notpritam/be10x`.
2. **Runtime: Docker** (it auto-detects the `Dockerfile`). Branch: `main`.
3. **Instance type:** Starter or above (needed for the disk).
4. **Advanced → Add Disk:** name `be10x-data`, mount path **`/data`**, size **1 GB**.
5. **Environment variables:**
   | Key | Value |
   |---|---|
   | `GFA_SECURE_COOKIES` | `1` |
   | `GFA_DB_PATH` | `/data/be10x.db` |
   - Do **not** set `PORT` (Render injects it; the image honors it).
   - Do **not** set `ANTHROPIC_API_KEY` (agents run on members' machines).
6. **Health check path:** `/`.
7. **Create Web Service.** Wait for the build, then open the URL.

---

## 2. What the disk is for

Everything durable lives on the `/data` disk:
- `/data/be10x.db` — the SQLite database (tasks, plans, comments, teams, tokens, runs).
- any git worktrees, if you ever also run agents on the server itself.

Because the DB is on the disk, **restarts and redeploys keep all your data.** Without a disk it would reset every deploy — that's why the free tier isn't usable for a real board.

---

## 3. First run

1. Open the board URL → **Sign up** (the first account is just a normal user).
2. Create a **team** and invite teammates by email (they sign up too).
3. You now have a working board. Next: let people run the agent from their own machines.

---

## 4. Custom domain (optional) — `be10x.notpritam.in`

1. In Render: your service → **Settings → Custom Domains → Add** → `be10x.notpritam.in`. Render shows a target hostname (like `be10x-XXXX.onrender.com`).
2. In your DNS (wherever `notpritam.in` is managed): add a **CNAME** record:
   | Type | Name | Value |
   |---|---|---|
   | CNAME | `be10x` | `be10x-XXXX.onrender.com` (the target Render showed) |
3. Wait for DNS to propagate (minutes to an hour). Render issues a TLS cert automatically. Your board is now at **`https://be10x.notpritam.in`**.

---

## 5. Connect your teammates (this is the whole point)

Each person, once, on their own machine:

```bash
# 1. Install the CLI (one command, no clone — needs Node 18+):
npm install -g github:notpritam/be10x

# 2. Sign in — opens the board in your browser; click "Authorize" (no token to copy):
be10x login https://be10x.notpritam.in

# 3. Link each repo you want worked here:
cd ~/code/app && be10x link

# 4. Run the agent as an always-on background service (starts on boot, restarts on crash):
be10x service install
```

`be10x login` opens the board's approve screen (you're already signed in there), you click **Authorize**, and the CLI collects a personal token over the back channel — saved to `~/.be10x/connect.json`, so a bare `be10x connect` works from then on. `be10x service install` runs that connector as a background daemon (macOS launchd / Linux systemd `--user`) so it survives logout and reboots — no terminal to keep open; `be10x service status|logs|uninstall` manage it. (Prefer to watch it live instead? Just run `be10x connect` in a terminal.) Now anyone creates a task for one of those repos on the board, hands it to the agent, and **that person's machine** picks it up, runs Claude locally, and streams the plan/progress/output back for the team to review.

> Headless box or CI (no browser to click Authorize)? Mint a token under **Connect your machine → Advanced** and run `be10x connect --board https://be10x.notpritam.in --token gfa_… --repos ~/code/app`.

> The CLI installs straight from the **public** `notpritam/be10x` repo — teammates need **no** GitHub access, just Node 18+. (Want the shorter `npm i -g be10x`? The repo is ready to publish to npm whenever you like.)

---

## 6. Backups

The DB is a single file. Snapshot the disk on a schedule, or copy the file out:

```bash
# from your machine, using the Render shell (Service → Shell):
cp /data/be10x.db /data/be10x-backup-$(date +%F).db
# or download /data/be10x.db via the Render shell / an object-store sync job.
```

---

## 7. Updating the board

`autoDeploy` is on, so **any push to `main`** rebuilds and redeploys automatically (zero-downtime, gated by the `/` health check). To pin/pause, turn off Auto-Deploy in the service settings.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| **Build fails on `better-sqlite3`** | The image installs a compiler toolchain already; if it still fails, retry the deploy (transient) or bump the instance to more RAM for the native build. |
| **Data resets after a deploy** | You're on the free tier / no disk. Add a disk at `/data` on a paid plan, set `GFA_DB_PATH=/data/be10x.db`. |
| **Health check failing** | Ensure the health check path is `/` (returns the UI, 200). `/api/*` needs auth and won't 200. |
| **Custom domain stuck "unverified"** | The CNAME must point at the exact target Render shows; check DNS with `dig be10x.notpritam.in`. |
| **A task never gets picked up** | Nothing's wrong with the board — check that **a teammate's `be10x connect` is running** and serving that repo's key. The board only coordinates; a machine has to be connected to do the work. |
| **"could not create worktree" on a task** | That task's project has no local checkout on the machine that took it. Make sure the connector serving it has that repo in `--repos`. |

---

## 9. Cost

- **Board:** one Starter web service + a 1 GB disk — a few dollars/month. No Claude spend on the server.
- **Agents:** run on teammates' machines against their own Claude Code plans — so agent cost is per-person, not centralized.

That's live. Board hosted, teammates connected, agents running where the code is.

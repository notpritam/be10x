# be10x

A human + agent task board. **Sessions are disposable; state is durable** — the board is the source of truth, and the agent that does the work is an ephemeral process that reports everything back to it.

- **Board:** HTTP API + SQLite + web UI, with a wake-driven agent runner baked in.
- **Agent:** a throwaway `claude` CLI per task step, in its own git worktree, wired to the board via the `gfa_*` MCP tools.
- See [`docs/architecture.html`](docs/architecture.html) for the full picture (open it in a browser).

---

## Join a board (2 minutes)

Someone shared a be10x board with you? Point your machine at it and it runs the agent on your own repos, with your own Claude login. All you need is **Node 18+**:

```bash
npm install -g github:notpritam/be10x        # 1. install the CLI (public repo — no access needed)
be10x login https://your-board.example.com   # 2. sign in: opens your browser, click Authorize
cd ~/code/your-repo && be10x link             # 3. link a repo you want the agent to work
be10x service install                         # 4. run it always-on in the background (starts on boot)
```

Now create a task on the board for that repo and **your** machine picks it up, runs Claude locally, and streams the plan + progress back for the whole team to review. Run `be10x` anytime to see your status, or `be10x update` to grab the latest.

---

## Run locally

```bash
npm install
npm test                       # 227 tests
npm run --prefix web build     # build the UI into public/  (only needed after web changes)
node bin/be10x.js serve        # board at http://localhost:4610
```

Then link a repo so the agent can work it:

```bash
cd /path/to/your/repo
GFA_DB_PATH=/absolute/path/to/gfa.db node /path/to/be10x/bin/be10x.js link
```

Install the `/be10x-adopt` skill to push a terminal session onto the board:

```bash
node bin/be10x.js install-skill
```

---

## Host it (Docker + automatic HTTPS)

be10x is a **stateful** service (a SQLite file on disk, it spawns the `claude` CLI, and it needs git worktrees on disk). Host it on a **VM/container with a persistent volume** — a small always-on VM, Fly.io with a volume, Railway, or Render with a disk. **Not** Vercel/Netlify (serverless, no persistent disk, can't run long-lived agent processes).

> **Easiest path — Render (one-click blueprint).** The repo ships a [`render.yaml`](render.yaml): Render Dashboard → **New → Blueprint** → pick this repo → **Apply** (it provisions the service + a `/data` disk). Full step-by-step — disk, custom domain, backups, and connecting teammates — is in **[docs/deploy.md](docs/deploy.md)**. For the hosted "each teammate runs the agent locally" model you don't set any Claude key on the server.

**Prerequisites:** a server with Docker + Docker Compose, a domain, and a DNS **A record** pointing at the server (Caddy needs public ports 80 + 443 for HTTPS).

```bash
cp .env.example .env      # set DOMAIN (+ optional ANTHROPIC_API_KEY)
docker compose up -d --build
```

That's it — Caddy issues TLS for your domain and proxies to the board. Open `https://your-domain`, sign up, and you're in.

### Agent auth (optional — the board works without it)

The board (tasks, plans, artifacts, review, share) runs with no Claude credentials. The **agent** needs one of:

- **Mode A — API key:** set `ANTHROPIC_API_KEY` in `.env`. The runner passes the container env to each agent, so nothing else is needed.
- **Mode B — mounted credentials:** uncomment the `~/.claude:/root/.claude:ro` volume in `docker-compose.yml` and leave `ANTHROPIC_API_KEY` blank.

### Let the agent work your repos

Mount the repos and link each one inside the container:

```yaml
# docker-compose.yml → be10x service
volumes:
  - be10x-data:/data
  - /srv/repos:/repos          # uncomment this
```

```bash
docker compose exec -w /repos/my-app be10x node bin/be10x.js link
```

### Backups

Everything durable is on the `be10x-data` volume (the SQLite DB + worktrees). Snapshot that volume, or copy `/data/be10x.db` out on a schedule.

---

## Connect your machine — run the agent on each teammate's computer

The hosting above is **single-host** (board + agent on one server). The other model — teammates running the agent on **their own** machines against a **shared hosted board** — is the **connector**. The board holds all state; each member links their machine to it and runs the agent locally, on their own repos, with their own Claude login. **Nothing runs on the server.**

**On the board (once):** host it as above (Render with a disk, a small VM, Fly, …). No `ANTHROPIC_API_KEY` needed — the baked-in runner just idles when there are no local repos; the connectors do the work.

**On each member's machine:**

```bash
# 1. Install the CLI — one command, no clone (needs Node 18+):
npm install -g github:notpritam/be10x

# 2. Sign in — opens the board in your browser; click "Authorize". The token installs itself, no paste:
be10x login https://your-board.example.com

# 3. In each repo you want worked here, link it:
cd ~/code/app && be10x link

# 4. Run the agent — foreground (to watch)…
be10x connect
#    …or as an always-on background service that auto-starts on login/boot (recommended):
be10x service install
```

`be10x login` uses a browser **device-authorization** flow (like `gh auth login`): the CLI shows a short code, opens the board's approve screen where you're already signed in, and collects a personal token over the back channel once you click **Authorize** — it never touches your clipboard. Everything is saved to `~/.be10x/connect.json`, so a bare `be10x connect` works next time. `be10x service install` turns that into a real background daemon (macOS launchd / Linux systemd) that starts on boot and restarts on crash — `be10x service status|logs|uninstall` manage it. `be10x link` registers the repo with the board and writes it a board-pointing MCP config; `be10x connect` then claims wakes for your linked repos, spawns **your** `claude` in each repo's worktree, and streams the plan / progress / output back to the board over HTTPS — where the whole team reviews and comments. Create a task for one of those repos on the board and your machine picks it up.

> Prefer no browser (CI, headless)? `be10x connect --board <url> --token <gfa_…> --repos a,b` still works — mint the token under **Connect your machine → Advanced**.

Under the hood: the agent's `gfa_*` tools reach the board through an HTTP MCP transport (`src/mcp/http-server.js` → `POST /api/agent/rpc`), and the runner claims/reports via `POST /api/agent/{claim,report}` — all authenticated with your personal token. The board owns every durability decision (auto-retry, verify hand-off), exactly as the in-process runner does. See [`docs/superpowers/specs/2026-07-02-distributed-runner-design.md`](docs/superpowers/specs/2026-07-02-distributed-runner-design.md).

---

## Honest status — what's built vs. not

- ✅ **Built & tested:** board, auth, teams/roles, tasks, plans, HTML artifacts, agent orchestration, share links, adopt-to-board, crash recovery, **distributed runners (teammates run the agent on their own machines over HTTPS)**, PWA (installable). 227 tests.
- **Two ways to run the agent:** single-host (board + agent on the server, credentials above) **or** the connector (each teammate runs it locally — see "Connect your machine").
- 🔜 **Not yet:** a hosted-managed Claude login (each member brings their own), and team-scoped tokens on the agent API — any valid token can drive tasks today, which is fine for a trusted team.

---

## Config reference

| Env | Default | What it does |
|---|---|---|
| `DOMAIN` | — | Public domain (Caddy HTTPS). |
| `GFA_DB_PATH` | `/data/be10x.db` | SQLite path (on the volume). |
| `GFA_SECURE_COOKIES` | `1` (image) | Add `Secure` to the session cookie (HTTPS deploys). |
| `GFA_CLAUDE_BIN` | `claude` | The Claude CLI the runner spawns. |
| `ANTHROPIC_API_KEY` | — | Agent auth Mode A. |
| `GFA_MODEL` / `GFA_EFFORT` | — | Default model / reasoning effort for agent runs. |

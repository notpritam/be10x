# be10x

A human + agent task board. **Sessions are disposable; state is durable** — the board is the source of truth, and the agent that does the work is an ephemeral process that reports everything back to it.

- **Board:** HTTP API + SQLite + web UI, with a wake-driven agent runner baked in.
- **Agent:** a throwaway `claude` CLI per task step, in its own git worktree, wired to the board via the `gfa_*` MCP tools.
- See [`docs/architecture.html`](docs/architecture.html) for the full picture (open it in a browser).

---

## Run locally

```bash
npm install
npm test                       # 188 tests
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

## Honest status — what's built vs. not

- ✅ **Built & tested:** board, auth, teams/roles, tasks, plans, HTML artifacts, agent orchestration, share links, adopt-to-board, crash recovery, PWA (installable). 188 tests.
- ⚠️ **This deploy is single-host:** the board + agents run on one server. Fine for a team hosting one board.
- 🔜 **Not yet:** teammates running agents on **their own machines** (distributed runners over HTTPS), and a hosted-managed Claude login. Until then, agents run on the host with the credentials above.

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

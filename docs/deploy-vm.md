# Deploy be10x on the VM (native, systemd)

This is the **primary** deployment: be10x runs directly on the VM (`35.209.46.62`) as
two native systemd services — **prod** (public, behind Caddy TLS) and **dev**
(loopback, for development). Replaces the Render blueprint (`render.yaml`), which is
kept only until DNS is cut over.

> **Why native, not Docker?** So you can develop *and* test on the same box: edit the
> source, `systemctl restart be10x-dev`, done — no image rebuild. Prod runs the same
> source tree, isolated only by its own DB, blob dir, and port.

## Layout

| | Prod | Dev |
|---|---|---|
| URL | `https://be10x.notpritam.in` | `http://127.0.0.1:4620` (SSH tunnel) |
| Port (loopback) | `4610` | `4620` |
| Data root | `~/be10x-data/prod/` | `~/be10x-data/dev/` |
| DB | `~/be10x-data/prod/be10x.db` | `~/be10x-data/dev/be10x.db` |
| Blobs | `~/be10x-data/prod/blobs/` | `~/be10x-data/dev/blobs/` |
| Worker id | `pritam` | `pritam-dev` |
| systemd | `be10x-prod.service` | `be10x-dev.service` |
| Env file | `~/be10x-data/prod/env` | `~/be10x-data/dev/env` |

Both services run as `pritam_emergent_sh`, so the runner-spawned `claude` inherits your
logged-in `~/.claude` — no `ANTHROPIC_API_KEY` needed.

## First-time setup

```bash
bash scripts/vm-setup.sh
```

Idempotent — safe to re-run after a `git pull`. It creates the data dirs + `~/repos`,
renders the env files, `npm link`s the CLI, installs + enables both systemd units, and
installs Caddy (staged, not started until DNS points here).

## The two manual steps (only you can do these)

1. **DNS** — repoint `be10x.notpritam.in` **A record → `35.209.46.62`**.
   The record currently fronts Render via Cloudflare. Set a plain A record to this IP with
   **Cloudflare proxy OFF (DNS-only / grey cloud)**, or Caddy's Let's Encrypt HTTP-01
   challenge fails.
2. **GCP firewall** — allow ingress **TCP `80,443`** to this VM. Either the console
   (VPC → Firewall) or:
   ```bash
   gcloud compute firewall-rules create be10x-web \
     --allow tcp:80,tcp:443 --direction INGRESS --target-tags http-server
   ```
   (ensure the VM carries the matching network tag).

Then bring prod public and verify:

```bash
sudo systemctl restart caddy
bash deploy/preflight.sh          # DNS→here? 80/443 open? services healthy?
```

## Create your account + link a repo

The board starts empty. Sign up (once), then link repos so the agent can work them.

```bash
# 1. sign up on the PROD board (choose your own password)
curl -sX POST http://127.0.0.1:4610/api/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"pritam@emergent.sh","displayName":"Pritam","password":"<pick-one>"}'

# 2. link a repo (agent's tool-access folder is ~/repos). Point the CLI at the PROD db:
cd ~/repos/<your-repo>
GFA_DB_PATH=~/be10x-data/prod/be10x.db GFA_EMAIL=pritam@emergent.sh be10x link
```

`be10x link` registers the repo as a project and writes `.be10x/mcp.json`. Create a task
for it on the board and the `pritam` runner picks it up, working the repo in its own git
worktree.

To develop against **dev** instead, use `GFA_DB_PATH=~/be10x-data/dev/be10x.db` and reach
the UI over an SSH tunnel: `ssh -L 4620:127.0.0.1:4620 <vm>` → `http://localhost:4620`.

## Operations

```bash
systemctl status be10x-prod be10x-dev caddy
journalctl -u be10x-prod -f              # tail prod logs
sudo systemctl restart be10x-prod        # after a deploy (git pull)
```

**Deploy a change to prod:** `git pull` in the source tree, then
`sudo systemctl restart be10x-prod`. (Rebuild the web UI first if you touched `web/`:
`npm run --prefix web build`.)

**Backups:** everything durable is under `~/be10x-data/` (SQLite DB + blobs + worktrees).
Snapshot that directory on a schedule; off-box backup is a TODO (not yet automated).

## Storage

QA bug-capture artifacts are stored on **local disk** under each env's `blobs/` dir
(`BUG_STORAGE=local`, `GFA_BLOB_DIR`), served by the board over signed `/blob/:key` URLs —
no UploadThing. An S3 driver is stubbed in `src/bugs/storage.js` for when local disk is
outgrown; switching is a one-file change plus `BUG_STORAGE=s3`.

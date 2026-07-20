# Self-host be10x on the VM — design

**Date:** 2026-07-20
**Owner:** pritam@emergent.sh
**Status:** approved (design), execution in progress

Move be10x off Render onto this GCP VM (public IP `35.209.46.62`), run isolated
**dev + prod** instances here, install the CLI under this machine's identity,
give the agent a folder of repos to work, and replace the UploadThing upload
dependency with local-disk storage behind an S3-ready seam.

One coherent project — "run be10x on this VM" — in two workstreams: **ops** (get
off Render) and **storage** (kill UploadThing). Ops lands first; Render stays up
until DNS is flipped.

---

## A. Topology & environments

Two isolated instances, both **native Node under systemd**, run from the **same
source tree** (`/home/pritam_emergent_sh/personal/git-for-agents`) and differing
only by environment. Data lives outside the source tree.

|                 | Prod                          | Dev                         |
|-----------------|-------------------------------|-----------------------------|
| Port (loopback) | `4610`                        | `4620`                      |
| Data root       | `~/be10x-data/prod/`          | `~/be10x-data/dev/`         |
| DB (`GFA_DB_PATH`) | `~/be10x-data/prod/be10x.db` | `~/be10x-data/dev/be10x.db` |
| Blobs (`GFA_BLOB_DIR`) | `~/be10x-data/prod/blobs/` | `~/be10x-data/dev/blobs/` |
| Exposure        | `https://be10x.notpritam.in` (Caddy) | `127.0.0.1:4620` only (SSH tunnel) |
| systemd unit    | `be10x-prod.service`          | `be10x-dev.service`         |

- Both services run as user `pritam_emergent_sh`, so the runner-spawned `claude`
  inherits the logged-in `~/.claude` — no `ANTHROPIC_API_KEY` needed (agent auth
  Mode B, for free).
- Node is under nvm (`/home/pritam_emergent_sh/.nvm/versions/node/v24.18.0/bin/node`);
  units reference an absolute node path (or set `PATH`) since systemd has no nvm.
- Prod = the deployed branch; dev = edit-and-`systemctl restart be10x-dev`.

## B. Internet edge (TLS)

**Caddy installed natively** (apt, its own `caddy.service`), reusing the existing
Caddyfile logic: `be10x.notpritam.in → localhost:4610`, auto Let's Encrypt TLS.

Two steps only the human can do (runbook gives exact commands + a preflight
verifier):
1. **DNS:** repoint `be10x.notpritam.in` A record from Render → `35.209.46.62`.
   The record currently fronts Render via Cloudflare — set it to a plain A record
   to this IP with **Cloudflare proxy OFF (DNS-only / grey cloud)**, or Caddy's
   HTTP-01 challenge fails.
2. **GCP firewall:** allow ingress TCP `80,443` to this VM.

Everything is built so that once DNS + firewall are set, Caddy issues TLS and prod
is live. No downtime: Render keeps serving the old A record until it's flipped.

## C. Tool-access folder + CLI identity

- `~/repos/` — the folder of repos the agent is allowed to work.
- Install the CLI via `npm link` from the source tree, so `be10x` on PATH tracks
  the working tree.
- Machine identity label **`pritam`** for this VM's runner/connector, so board
  activity is attributable to it.
- Link `git-for-agents` itself as the first project; add `~/repos/*` as needed.

## D. Storage seam (replace UploadThing)

New `src/bugs/storage.js` — a driver interface selected by `BUG_STORAGE` env
(`local` default; `s3` a documented stub):

```
presignUpload(files)  -> [{ key, uploadUrl, fileUrl }]   // where the extension PUTs, and the stored URL
read(key)             -> Buffer                          // on-host disk read (MCP bug-tools)
signReadUrl(key)      -> short-lived URL                 // browser <img>/fetch
```

**Local driver** rewires the flow so bytes land on this VM, not UploadThing:

- `POST /api/agent/bugs/upload-urls` returns `uploadUrl` pointing at the **board
  itself**: `PUT /api/agent/bugs/blob/:key` (new, Bearer-authed, mirrors
  `/api/agent/bugs` auth) which streams the body to `GFA_BLOB_DIR/<key>`.
- Reads: `signReadUrl(key)` → `/blob/:key?exp=<ms>&sig=HMAC(key|exp)`; new
  `GET /blob/:key` validates `sig` + `exp` and streams from disk. Replaces every
  `signAccessUrl` call site: `/api/bugs/:id/artifact/:kind`, the bug-share
  artifact route, and `bug_screenshot_url`.
- MCP bug-tools currently doing `fetch(signAccessUrl(key))` use `storage.read(key)`
  directly (the agent runs on this host).
- Signing secret: HMAC keyed by an existing server secret (session/cookie secret)
  — no `UPLOADTHING_TOKEN`.

`src/bugs/uploadthing.js` stays in the tree but is unwired; `UPLOADTHING_TOKEN`
becomes unused (documented as legacy in `.env.example`). **S3 driver** is a
documented stub (presigned S3 PUT/GET) so the later swap is one file. Built
**test-first**, mirroring the existing deterministic signer tests.

**Key generation:** keep opaque, collision-resistant keys (uuid-based) namespaced
like `bugs/<bugId>/<seed>-<name>`; no UploadThing sqids/appId coupling.

## E. Deliverables

- `scripts/vm-setup.sh` — idempotent: create data dirs + `~/repos`, install Caddy,
  render + enable both systemd units, `npm link`, print the DNS/firewall checklist.
- `deploy/` — `be10x-prod.service`, `be10x-dev.service`, native `Caddyfile`, and
  `preflight.sh` (DNS resolves to this IP? 80/443 reachable? services healthy?).
- `docs/deploy-vm.md` — the VM runbook (replaces the Render path in README as the
  primary; Render config left intact until cutover).
- Storage-seam code + tests (`src/bugs/storage.js`, endpoint changes, call-site swaps).

## Sequencing

1. **Ops (A–C, E ops bits)** — executed on this VM now: dirs, Caddy, systemd units,
   `npm link`, `~/repos`, link first project. Both instances bound to loopback and
   healthy locally; only DNS + firewall remain for the human to flip prod public.
2. **Storage (D)** — TDD code change, reviewed, then dev-tested, then prod.

## Out of scope (follow-ups)

- **Remote connectors fetching artifacts over the wire.** Today the agent runs on
  this same VM, so on-host `storage.read` covers it. Cross-host artifact fetch
  (connector → board blob endpoint with a server-minted token) is a later item.
- **S3 driver implementation.** Seam + stub now; wire when we outgrow local disk.
- **Off-box backups** of `~/be10x-data` (snapshot/cron) — note in runbook, not built.

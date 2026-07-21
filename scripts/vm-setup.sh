#!/usr/bin/env bash
# be10x — one-shot VM setup. Idempotent: safe to re-run after a git pull.
# Stands up native dev + prod board instances under systemd, installs Caddy for the prod TLS edge,
# creates the ~/repos tool-access folder, and links the be10x CLI onto PATH.
#
# Does NOT touch DNS or the GCP firewall (only you can) — it prints that checklist at the end.
# Usage:  bash scripts/vm-setup.sh          (uses sudo for apt/systemctl/caddy)
set -euo pipefail

# ---- resolved environment -------------------------------------------------
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(id -un)"
USER_HOME="$HOME"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
DATA_ROOT="$USER_HOME/be10x-data"
REPOS_DIR="$USER_HOME/repos"
DOMAIN="be10x.notpritam.in"

echo "be10x VM setup"
echo "  repo:   $REPO"
echo "  user:   $USER_NAME   home: $USER_HOME"
echo "  node:   $NODE_BIN"
echo "  data:   $DATA_ROOT"
echo

render() { # render <tmpl> <env> <data> <port> <secure> <worker> <workeruser>
  sed -e "s#__ENV__#$2#g" -e "s#__NODE__#$NODE_BIN#g" -e "s#__NODEDIR__#$NODE_DIR#g" \
      -e "s#__REPO__#$REPO#g" -e "s#__USER__#$USER_NAME#g" -e "s#__HOME__#$USER_HOME#g" \
      -e "s#__DATA__#$3#g" -e "s#__PORT__#$4#g" -e "s#__SECURE__#$5#g" -e "s#__WORKER__#${6:-runner}#g" \
      -e "s#__WORKERUSER__#${7:-}#g" -e "s#__ENVFILE__#$DATA_ROOT/$2/env#g" "$1"
}

# ---- 1. data dirs + tool-access folder ------------------------------------
echo "[1/6] data dirs + ~/repos"
for env in prod dev; do
  mkdir -p "$DATA_ROOT/$env/blobs"
done
mkdir -p "$REPOS_DIR"
echo "  ok"

# ---- 2. env files ---------------------------------------------------------
echo "[2/6] env files"
render "$REPO/deploy/be10x.env.tmpl" prod "$DATA_ROOT/prod" 4610 1 pritam notpritam@notpritam.in > "$DATA_ROOT/prod/env"
render "$REPO/deploy/be10x.env.tmpl" dev  "$DATA_ROOT/dev"  4620 0 pritam-dev "" > "$DATA_ROOT/dev/env"
chmod 600 "$DATA_ROOT/prod/env" "$DATA_ROOT/dev/env"
echo "  ok"

# ---- 3. npm deps + link CLI ----------------------------------------------
echo "[3/6] npm install + link CLI (be10x on PATH)"
( cd "$REPO" && npm install --no-audit --no-fund >/dev/null 2>&1 || true )
( cd "$REPO" && npm link >/dev/null 2>&1 ) && echo "  be10x -> $(command -v be10x || echo '(re-open shell)')" || echo "  npm link skipped"

# ---- 4. systemd units -----------------------------------------------------
echo "[4/6] systemd units (be10x-prod, be10x-dev)"
render "$REPO/deploy/be10x.service.tmpl" prod "$DATA_ROOT/prod" 4610 1 | sudo tee /etc/systemd/system/be10x-prod.service >/dev/null
render "$REPO/deploy/be10x.service.tmpl" dev  "$DATA_ROOT/dev"  4620 0 | sudo tee /etc/systemd/system/be10x-dev.service  >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now be10x-prod be10x-dev
echo "  enabled + started"

# ---- 5. Caddy (prod TLS edge) --------------------------------------------
echo "[5/6] Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  echo "  installing caddy via apt..."
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null 2>&1 || true
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update >/dev/null 2>&1
  sudo apt-get install -y caddy >/dev/null 2>&1
fi
sudo cp "$REPO/deploy/Caddyfile" /etc/caddy/Caddyfile
# Reload only if DNS already points here; otherwise the ACME challenge would fail — leave caddy for the human step.
VMIP="$(curl -s --max-time 5 ifconfig.me || true)"
DNSIP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
if [ -n "$VMIP" ] && [ "$DNSIP" = "$VMIP" ]; then
  sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy
  echo "  DNS already points here — caddy reloaded (TLS will issue)"
else
  echo "  caddy installed but NOT started (DNS not pointed here yet — see checklist)"
fi

# ---- 6. done --------------------------------------------------------------
echo "[6/6] done"
echo
echo "Local health:"
for pair in prod:4610 dev:4620; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${pair##*:}/" || echo down)"
  echo "  ${pair%%:*}: http://127.0.0.1:${pair##*:}/  -> HTTP $code"
done
cat <<EOF

── YOUR TWO MANUAL STEPS (only you can do these) ─────────────────────────────
 1. DNS:  point ${DOMAIN}  A record →  ${VMIP:-<this-VM-IP>}
          (Cloudflare: set to DNS-only / grey cloud, or Caddy's TLS fails)
 2. GCP firewall: allow ingress  tcp:80,443  to this VM
 Then:    sudo systemctl restart caddy   &&   bash deploy/preflight.sh
──────────────────────────────────────────────────────────────────────────────
EOF

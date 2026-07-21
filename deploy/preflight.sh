#!/usr/bin/env bash
# be10x — preflight verifier. Read-only: checks whether the VM is ready to serve prod publicly.
# Run any time after scripts/vm-setup.sh. Exits non-zero if any REQUIRED check fails.
set -u
DOMAIN="${1:-be10x.notpritam.in}"
PROD_PORT="${PROD_PORT:-4610}"
DEV_PORT="${DEV_PORT:-4620}"

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

myip() { curl -s --max-time 5 ifconfig.me; }
VMIP="$(myip)"

echo "be10x preflight — domain: $DOMAIN, this VM: ${VMIP:-unknown}"
echo

echo "[1] Local services (loopback health)"
for pair in "prod:$PROD_PORT" "dev:$DEV_PORT"; do
  name="${pair%%:*}"; port="${pair##*:}"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/" 2>/dev/null)"
  [ "$code" = "200" ] && ok "$name board healthy on 127.0.0.1:$port (HTTP $code)" \
                       || bad "$name board NOT healthy on 127.0.0.1:$port (got '${code:-no response}') — 'systemctl status be10x-$name'"
done

echo "[2] systemd units"
for name in prod dev; do
  state="$(systemctl is-active "be10x-$name" 2>/dev/null)"
  [ "$state" = "active" ] && ok "be10x-$name is $state" || bad "be10x-$name is '${state:-missing}'"
done
cstate="$(systemctl is-active caddy 2>/dev/null)"
[ "$cstate" = "active" ] && ok "caddy is $cstate" || warn "caddy is '${cstate:-missing}' (start it once DNS+firewall are set)"

echo "[3] DNS — $DOMAIN should resolve to $VMIP"
resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)"
if [ -z "$resolved" ]; then bad "$DOMAIN does not resolve"
elif [ "$resolved" = "$VMIP" ]; then ok "$DOMAIN → $resolved (this VM)"
else warn "$DOMAIN → $resolved (NOT this VM yet — still Render/Cloudflare? repoint the A record)"; fi

echo "[4] Public edge — TCP 80/443 reachable from the internet"
for p in 80 443; do
  if timeout 6 bash -c "curl -s -o /dev/null --max-time 5 http://$VMIP:$p/ 2>/dev/null"; then ok "port $p reachable at $VMIP"
  else warn "port $p not reachable at $VMIP (open GCP firewall ingress tcp:$p, and start caddy)"; fi
done

echo
if [ "$fail" -eq 0 ]; then
  echo "PREFLIGHT OK — $pass checks passed. (Warnings above are the human DNS/firewall steps.)"
else
  echo "PREFLIGHT: $fail required check(s) FAILED, $pass passed."
fi
exit "$fail"

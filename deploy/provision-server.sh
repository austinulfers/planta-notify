#!/usr/bin/env bash
#
# ============================================================================
#  OffHoursLab — shared host provisioning
# ============================================================================
#
# Provisions a bare Ubuntu VPS as a multi-app host. This script installs ONLY
# the layer shared by every app; each app is installed afterwards by its own
# setup script. Run this once per machine (it is idempotent, so re-running to
# repair drift or rebuild after a wipe is safe and expected).
#
# ---------------------------------------------------------------------------
#  THE BOX
# ---------------------------------------------------------------------------
#
#   Host      OffHoursLabs-Server (Hetzner VPS)
#   OS        Ubuntu 26.04 LTS
#   Specs     1 vCPU, 1.9 GB RAM  <-- small! see MEMORY below
#   Access    ssh offhourslab           (root, key ~/.ssh/id_ed25519_hetzner)
#   DNS       *.offhourslab.com  A -> this server
#   Runtime   node (apt), nginx 1.28, certbot
#
# Every app is a systemd service listening on its own loopback-only port, with
# nginx terminating TLS on a per-app subdomain and reverse-proxying to it:
#
#   internet --443--> nginx --> 127.0.0.1:PORT --> node (systemd unit)
#              (TLS)     (per-app vhost)
#
# ---------------------------------------------------------------------------
#  ARCHITECTURE RULES (follow these when adding an app)
# ---------------------------------------------------------------------------
#
#  1. ONE PORT PER APP, LOOPBACK ONLY.
#     Apps must bind 127.0.0.1, never 0.0.0.0. The firewall does not open app
#     ports, so a 0.0.0.0 bind is not immediately exploitable — but it is one
#     firewall mistake away from exposing an untrusted, non-TLS port. Make the
#     bind address configurable (e.g. a HOST env var) and set it in the unit.
#     Check what is already taken before choosing:  ss -tlnp | grep LISTEN
#
#  2. TWO USERS PER APP: a service account and a deploy account.
#       <app>          system user, nologin, RUNS the process, read-only on code
#       deploy-<app>   owns /opt/<app>, is what CI logs in as, cannot run as root
#     /opt/<app> is mode 750, owned deploy-<app>:<app>. The split means a
#     compromised app process cannot rewrite its own code, and a leaked CI key
#     cannot touch the rest of the box.
#
#  3. CI NEVER LOGS IN AS ROOT.
#     Give deploy-<app> a narrow sudoers grant for its own unit only:
#       deploy-<app> ALL=(root) NOPASSWD: /usr/bin/systemctl restart <app>, \
#                                         /usr/bin/systemctl is-active <app>
#     Verify the negative case after setup — `sudo systemctl restart nginx` as
#     that user MUST fail.
#
#  4. ALWAYS SET MemoryMax.
#     See MEMORY below. An unbounded app on this box kills its neighbours.
#
#  5. NOTHING IS REACHED EXCEPT THROUGH NGINX.
#     Never `ufw allow <app port>`. If you think you need to, you don't.
#
# ---------------------------------------------------------------------------
#  MEMORY: the main constraint on this host
# ---------------------------------------------------------------------------
#
# 1.9 GB total. Without limits, one leaky app triggers the kernel OOM killer,
# which may kill a DIFFERENT app than the one at fault. So:
#   - this script adds 2 GB of swap (vm.swappiness=10) as a shock absorber
#   - every unit MUST set MemoryMax (hard cap) and ideally MemoryHigh (~75%,
#     a soft throttle that reclaims before the hard kill)
# Budget conservatively: a small node service is happy at MemoryMax=512M.
# Sum of all MemoryMax should stay comfortably under ~1.5 GB.
#
# ---------------------------------------------------------------------------
#  GOTCHAS — each of these cost real debugging time. Do not rediscover them.
# ---------------------------------------------------------------------------
#
#  * systemd MemoryDenyWriteExecute=true KILLS NODE.
#    V8's JIT needs write+execute pages; node dies at startup with
#    SIGTRAP/core-dump. Every other hardening directive used here is fine. And
#    because Restart=always makes a crash-loop report "activating" rather than
#    "failed", `systemctl is-active` looks merely slow instead of broken —
#    poll for the "active" state in a loop instead of trusting one call.
#
#  * Rewriting an nginx vhost SILENTLY DROPS TLS.
#    certbot injects its `listen 443 ssl` block into sites-available/<app>. A
#    setup script that regenerates that file removes it, and the site quietly
#    falls back to plain HTTP. If a cert already exists, re-attach it:
#      certbot install --nginx --cert-name <domain> --redirect -n
#
#  * server_tokens is ALREADY DECLARED in Ubuntu's nginx.conf.
#    Adding it again in conf.d/ is a duplicate-directive fatal error that takes
#    nginx down on reload. Handled below; don't "helpfully" re-add it.
#
#  * WebSocket apps need the shared $connection_upgrade map.
#    Defined once here in conf.d/websocket-upgrade.conf (server-wide, despite
#    living in a file named for no particular app). A vhost that sets
#    `proxy_set_header Connection "upgrade"` unconditionally breaks plain HTTP
#    keepalive; use the map. Also raise proxy_read_timeout — long-lived idle
#    sockets are dropped at the default 60s.
#
#  * The Node install below is skipped if any node already exists, so the
#    running version may be older than NODE_MAJOR here. Check `node --version`
#    if an app needs a specific one.
#
#  * apt may hold a dpkg lock right after boot; if apt-get fails, wait and
#    re-run rather than forcing the lock.
#
# ---------------------------------------------------------------------------
#  ADDING A NEW APP — checklist
# ---------------------------------------------------------------------------
#
#   1. DNS: <app>.offhourslab.com  A -> this server's IP (must resolve BEFORE
#      requesting a cert, or the ACME HTTP-01 challenge fails)
#   2. Write deploy/setup-<app>.sh. Copy megahex's — it is the reference
#      implementation of every rule above (users, sudoers, unit, vhost, cert,
#      CI key install) and is idempotent.
#   3. Pick a free port; set it explicitly in the unit, never rely on the
#      app's built-in default.
#   4. Run it as root: `ssh -t offhourslab /root/setup-<app>.sh`
#   5. Point CI at deploy-<app> (repo secrets DEPLOY_HOST / DEPLOY_USER /
#      DEPLOY_SSH_KEY), and remove any root-level CI key when done.
#   6. Verify: HTTPS 200, HTTP->HTTPS 301, correct loopback bind, MemoryMax
#      applied, and the deploy user CANNOT restart nginx.
#
#   Port registry (keep this current):
#     3000  megahex        megahex.offhourslab.com
#     3001  planta-notify  plants.offhourslab.com
#
# ---------------------------------------------------------------------------
#  DISASTER RECOVERY (server wiped)
# ---------------------------------------------------------------------------
#
#   scp deploy/*.sh offhourslab:/root/
#   ssh offhourslab /root/provision-server.sh     # this file: shared layer
#   ssh -t offhourslab /root/setup-<app>.sh       # once per app
#
# Nothing on the box is a source of truth: code comes from git, certs are
# re-issuable, and app state is per-app (megahex is entirely in-memory, so it
# has nothing to restore). If an app has a database, it needs its own backup
# story — this script does not provide one.
#
# ---------------------------------------------------------------------------
#  USAGE
# ---------------------------------------------------------------------------
#
#   As root on the server:   ./provision-server.sh
#   From a laptop:           scp deploy/provision-server.sh offhourslab:/root/ \
#                              && ssh offhourslab /root/provision-server.sh
#
# ============================================================================

set -euo pipefail

SWAP_SIZE=2G
SWAPFILE=/swapfile
NODE_MAJOR=22

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root." >&2
  exit 1
fi

log "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx ufw curl git

log "Installing Node.js $NODE_MAJOR (if missing)"
# Deliberately does not upgrade an existing node: apps in /opt are already
# running against it and a silent major bump is a bad surprise. Upgrade
# explicitly, and restart each app, if you actually want a newer runtime.
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
node --version

log "Configuring firewall (deny incoming; allow SSH + HTTP/HTTPS only)"
# App ports are deliberately NOT opened: every app is reached through nginx.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
ufw status verbose

log "Configuring swap"
# 1.9 GB RAM with no swap means one app's memory spike OOM-kills its
# neighbours. Swap is the shock absorber; MemoryMax per unit is the real fix.
if swapon --show | grep -q .; then
  echo "swap already active, skipping"
else
  fallocate -l "$SWAP_SIZE" "$SWAPFILE"
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE"
  swapon "$SWAPFILE"
  grep -q "^$SWAPFILE" /etc/fstab || echo "$SWAPFILE none swap sw 0 0" >>/etc/fstab
fi
# Prefer reclaiming page cache over swapping live app memory out.
echo 'vm.swappiness=10' >/etc/sysctl.d/99-swappiness.conf
sysctl -q -p /etc/sysctl.d/99-swappiness.conf
free -h

log "Installing shared WebSocket upgrade map"
# Server-wide, used by any app vhost that proxies WebSockets:
#   proxy_set_header Upgrade    $http_upgrade;
#   proxy_set_header Connection $connection_upgrade;
# The map yields "upgrade" for upgrade requests and "close" otherwise, which
# is what keeps ordinary HTTP keepalive working on the same vhost.
cat >/etc/nginx/conf.d/websocket-upgrade.conf <<'NGINX'
# Shared by all app vhosts (see sites-available/*). Do not make app-specific.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
NGINX
# Remove the old app-scoped filename if this box predates the rename.
rm -f /etc/nginx/conf.d/megahex-upgrade.conf

log "Hardening nginx a little"
# Don't advertise the exact nginx version. Ubuntu's nginx.conf already ships a
# (commented or active) server_tokens line — setting it again in conf.d is a
# duplicate-directive error, so only add ours if http{} doesn't define one.
rm -f /etc/nginx/conf.d/hardening.conf
if grep -qE '^\s*server_tokens' /etc/nginx/nginx.conf; then
  sed -i -E 's/^\s*server_tokens.*/\tserver_tokens off;/' /etc/nginx/nginx.conf
  echo "set server_tokens off in nginx.conf"
else
  echo 'server_tokens off;' >/etc/nginx/conf.d/hardening.conf
  echo "added conf.d/hardening.conf"
fi

log "Enabling services"
systemctl enable --now nginx
# certbot.timer renews certs automatically and reloads nginx; without it every
# app's TLS silently expires after 90 days.
systemctl enable --now certbot.timer

log "Validating nginx config"
# Always `nginx -t` before reload: a bad config on reload takes down EVERY app
# on the box, not just the one you were editing.
nginx -t
systemctl reload nginx

log "Done. Shared layer ready."
cat <<'EOF'

Next steps — for EACH app:
  1. Point DNS: <app>.offhourslab.com  A  -> this server's IP
  2. Run that app's setup script (e.g. setup-megahex.sh), which creates the
     service user, the deploy user, /opt/<app>, the systemd unit, the nginx
     vhost and the certificate.

Remember: every app needs its OWN port, its OWN users, and a MemoryMax.
  ss -tlnp | grep LISTEN     # ports already taken
  ls /opt                    # apps already installed
  free -h                    # remaining memory headroom
EOF

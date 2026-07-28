#!/usr/bin/env bash
# Install planta-notify as an app on an already-provisioned OffHoursLab host.
# Run provision-server.sh first (nginx, certbot, ufw, swap).
#
# Creates:
#   - planta-notify         service user (nologin, runs the app, read-only on code)
#   - deploy-planta-notify  deploy user  (owns /opt/planta-notify, may restart ONLY this app)
#   - /opt/planta-notify    git checkout
#   - /var/lib/planta-notify  SQLite data dir (service-owned; the ONE place the app can write)
#   - /etc/planta-notify/env  secrets (VAPID keys generated on first run, never rotated)
#   - systemd unit planta-notify.service (PORT 3001 + MemoryMax + hardening)
#   - nightly SQLite backup timer (14-day rotation)
#   - nginx vhost plants.offhourslab.com -> 127.0.0.1:3001
#   - Let's Encrypt certificate
#
# Idempotent — safe to re-run. Existing VAPID keys and the database are preserved.
#
# Usage (as root on the server):
#   CERTBOT_EMAIL=you@example.com PERENUAL_API_KEY=sk-... SEED_EMAIL=you@example.com ./setup-planta-notify.sh
#   SKIP_CERT=1 ./setup-planta-notify.sh          # e.g. DNS not pointed here yet
#
# From your laptop:
#   scp deploy/setup-planta-notify.sh offhourslab:/root/ && ssh -t offhourslab /root/setup-planta-notify.sh

set -euo pipefail

APP=planta-notify
DOMAIN=${DOMAIN:-plants.offhourslab.com}
PORT=${PORT:-3001}
MEMORY_MAX=${MEMORY_MAX:-256M}
REPO=${REPO:-https://github.com/austinulfers/planta-notify.git}
BRANCH=${BRANCH:-main}
APP_DIR=/opt/$APP
DATA_DIR=/var/lib/$APP
ENV_FILE=/etc/$APP/env
DEPLOY_USER=deploy-$APP
SKIP_CERT=${SKIP_CERT:-0}

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root." >&2
  exit 1
fi
command -v nginx >/dev/null || { echo "nginx missing — run provision-server.sh first." >&2; exit 1; }
command -v node >/dev/null || { echo "node missing — run provision-server.sh first." >&2; exit 1; }

# sqlite3 CLI is needed by the backup job (the app itself uses better-sqlite3).
command -v sqlite3 >/dev/null || { log "Installing sqlite3 (for backups)"; apt-get install -y -qq sqlite3; }

# MemoryHigh (soft throttle) at 75% of MemoryMax (hard kill).
[[ $MEMORY_MAX =~ ^[0-9]+M$ ]] || { echo "MEMORY_MAX must look like 256M" >&2; exit 1; }
MEMORY_HIGH=$(( ${MEMORY_MAX%M} * 3 / 4 ))M

# Refuse to steal a port another app is already serving on.
if ss -tlnpH 2>/dev/null | grep -q ":$PORT .*users:" && \
   ! systemctl is-active --quiet "$APP"; then
  echo "Port $PORT is already in use by another process. Pick a free PORT." >&2
  ss -tlnp | grep ":$PORT " >&2 || true
  exit 1
fi

log "Creating users"
id -u "$APP" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP"
id -u "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"

log "Preparing $APP_DIR"
mkdir -p "$APP_DIR"
chown -R "$DEPLOY_USER:$APP" "$APP_DIR"
sudo -u "$DEPLOY_USER" git config --global --add safe.directory "$APP_DIR"

if [[ -d $APP_DIR/.git ]]; then
  echo "checkout exists, fetching"
  sudo -u "$DEPLOY_USER" git -C "$APP_DIR" fetch --all --quiet
  sudo -u "$DEPLOY_USER" git -C "$APP_DIR" reset --hard "origin/$BRANCH" --quiet
else
  sudo -u "$DEPLOY_USER" git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

# Deploy user writes; service user only reads (group). No world access.
chown -R "$DEPLOY_USER:$APP" "$APP_DIR"
chmod -R g+rX,o-rwx "$APP_DIR"

log "Installing production dependencies"
sudo -u "$DEPLOY_USER" env -C "$APP_DIR" npm install --omit=dev --no-audit --no-fund

log "Preparing data dir $DATA_DIR"
# Unlike the code dir, this is owned by the SERVICE user — it is the one
# path the app may write (enforced by ReadWritePaths in the unit).
install -d -m 750 -o "$APP" -g "$APP" "$DATA_DIR"
install -d -m 750 -o "$APP" -g "$APP" "$DATA_DIR/backups"

log "Writing $ENV_FILE"
install -d -m 755 "/etc/$APP"
touch "$ENV_FILE"
chown "root:$APP" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# Helper: set KEY=VALUE only if KEY is not already present — re-running the
# script must never clobber existing secrets.
setenv_if_missing() {
  local key=$1 value=$2
  grep -q "^${key}=" "$ENV_FILE" || echo "${key}=${value}" >>"$ENV_FILE"
}

# VAPID keys: generated ONCE, then never touched again. Push subscriptions are
# cryptographically bound to the public key — rotating it silently kills every
# existing subscription on every phone.
if ! grep -q '^VAPID_PUBLIC_KEY=' "$ENV_FILE"; then
  echo "generating VAPID keypair (first run)"
  VAPID_JSON=$(sudo -u "$DEPLOY_USER" env -C "$APP_DIR" node -e '
    const webpush = require("web-push");
    const k = webpush.generateVAPIDKeys();
    console.log(JSON.stringify(k));')
  VAPID_PUBLIC=$(node -e "console.log(JSON.parse(process.argv[1]).publicKey)" "$VAPID_JSON")
  VAPID_PRIVATE=$(node -e "console.log(JSON.parse(process.argv[1]).privateKey)" "$VAPID_JSON")
  echo "VAPID_PUBLIC_KEY=$VAPID_PUBLIC" >>"$ENV_FILE"
  echo "VAPID_PRIVATE_KEY=$VAPID_PRIVATE" >>"$ENV_FILE"
fi

setenv_if_missing VAPID_SUBJECT "mailto:${CERTBOT_EMAIL:-admin@offhourslab.com}"
setenv_if_missing SESSION_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
setenv_if_missing TIMEZONE "America/Los_Angeles"
[[ -n ${PERENUAL_API_KEY:-} ]] && setenv_if_missing PERENUAL_API_KEY "$PERENUAL_API_KEY"
[[ -n ${SEED_EMAIL:-} ]] && setenv_if_missing SEED_EMAIL "$SEED_EMAIL"

grep -q '^PERENUAL_API_KEY=' "$ENV_FILE" || echo "WARNING: PERENUAL_API_KEY not set — species search will be disabled until you add it to $ENV_FILE"
grep -q '^SEED_EMAIL=' "$ENV_FILE" || echo "WARNING: SEED_EMAIL not set — no user will exist; add it and restart, or use scripts/add-user.js"

log "Granting $DEPLOY_USER permission to restart ONLY $APP"
cat >"/etc/sudoers.d/$DEPLOY_USER" <<EOF
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $APP, /usr/bin/systemctl is-active $APP, /usr/bin/systemctl status $APP
EOF
chmod 440 "/etc/sudoers.d/$DEPLOY_USER"
visudo -cqf "/etc/sudoers.d/$DEPLOY_USER"

log "Writing systemd unit"
cat >"/etc/systemd/system/$APP.service" <<EOF
[Unit]
Description=planta-notify plant care reminders
After=network.target

[Service]
Type=simple
User=$APP
Group=$APP
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
Environment=PORT=$PORT
# Loopback only — nginx is the only thing that should reach this port.
Environment=HOST=127.0.0.1
Environment=DB_PATH=$DATA_DIR/plants.db
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3

# Cap memory so one app cannot OOM-kill its neighbours on a small box.
MemoryMax=$MEMORY_MAX
MemoryHigh=$MEMORY_HIGH

# Hardening. ProtectSystem=strict makes the whole FS read-only for the
# service; ReadWritePaths carves out the single directory the DB lives in.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
RestrictSUIDSGID=true
# NOTE: MemoryDenyWriteExecute is deliberately NOT set — V8's JIT needs
# write+execute pages and Node dies with SIGTRAP during startup if it is on.

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$APP"
systemctl restart "$APP"

# Restart=always means a crash-looping unit reports "activating", not "failed",
# so poll for a genuinely running state instead of trusting one is-active call.
state=unknown
for _ in $(seq 1 10); do
  state=$(systemctl is-active "$APP" || true)
  [[ $state == active ]] && break
  sleep 1
done
if [[ $state != active ]]; then
  echo "ERROR: $APP did not come up (state=$state)" >&2
  journalctl -u "$APP" -n 30 --no-pager >&2
  exit 1
fi
echo "$APP is active"

log "Installing nightly database backup (03:17, 14-day rotation)"
cat >"/etc/systemd/system/$APP-backup.service" <<EOF
[Unit]
Description=planta-notify SQLite backup

[Service]
Type=oneshot
User=$APP
Group=$APP
# .backup is transactionally safe against a live WAL database.
ExecStart=/bin/sh -c 'sqlite3 $DATA_DIR/plants.db ".backup $DATA_DIR/backups/plants-\$(date +%%F).db"'
ExecStartPost=/bin/sh -c 'find $DATA_DIR/backups -name "plants-*.db" -mtime +14 -delete'
EOF
cat >"/etc/systemd/system/$APP-backup.timer" <<EOF
[Unit]
Description=Nightly planta-notify backup

[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now "$APP-backup.timer"

log "Writing nginx vhost"
# Plain HTTP only here; certbot adds the TLS server block and the redirect.
cat >"/etc/nginx/sites-available/$APP" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # Bodies are small JSON (subscriptions, plant edits).
    client_max_body_size 64k;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # A lapsed cert kills the service worker AND the push subscription, so
    # HSTS doubles as insurance against accidental plain-HTTP regressions.
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
}
EOF
ln -sfn "/etc/nginx/sites-available/$APP" "/etc/nginx/sites-enabled/$APP"
nginx -t
systemctl reload nginx

if [[ $SKIP_CERT == 1 ]]; then
  log "SKIP_CERT=1 — serving plain HTTP only. Add TLS later with:"
  echo "  certbot --nginx -d $DOMAIN --redirect"
elif [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  # The vhost above was just overwritten as HTTP-only, so an existing cert still
  # needs its server block re-installed — otherwise the site drops to port 80.
  log "Certificate exists for $DOMAIN — reinstalling into the vhost"
  certbot install --nginx --cert-name "$DOMAIN" --redirect -n
  nginx -t && systemctl reload nginx
else
  log "Requesting certificate for $DOMAIN"
  cert_args=(--nginx -d "$DOMAIN" --redirect --agree-tos --no-eff-email)
  [[ -n ${CERTBOT_EMAIL:-} ]] && cert_args+=(--email "$CERTBOT_EMAIL" -n)
  certbot "${cert_args[@]}"
fi

log "Installing deploy key (if provided)"
# Add the CI public key with GITHUB_DEPLOY_KEY="ssh-ed25519 AAAA... github-actions-deploy"
if [[ -n ${GITHUB_DEPLOY_KEY:-} ]]; then
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
  AK="/home/$DEPLOY_USER/.ssh/authorized_keys"
  touch "$AK"
  LINE="restrict,pty $GITHUB_DEPLOY_KEY"
  grep -qF "$GITHUB_DEPLOY_KEY" "$AK" || echo "$LINE" >>"$AK"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$AK"
  chmod 600 "$AK"
  echo "installed"
else
  echo "GITHUB_DEPLOY_KEY not set — add the CI public key to /home/$DEPLOY_USER/.ssh/authorized_keys manually."
fi

log "Done"
cat <<EOF

  App:      https://$DOMAIN
  Service:  systemctl status $APP   |   journalctl -u $APP -f
  Port:     127.0.0.1:$PORT (not internet-reachable)
  Code:     $APP_DIR (owned by $DEPLOY_USER, read by $APP)
  Data:     $DATA_DIR/plants.db (backups nightly in $DATA_DIR/backups)
  Secrets:  $ENV_FILE

  Login codes are printed to the journal (no email in v1):
    journalctl -u $APP -f | grep '\[auth\]'

  GitHub secrets for the deploy workflow:
    DEPLOY_HOST     = this server's IP
    DEPLOY_USER     = $DEPLOY_USER
    DEPLOY_SSH_KEY  = private half of the CI deploy key
EOF

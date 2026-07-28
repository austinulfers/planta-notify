# planta-notify

A self-hosted plant watering and fertilizing reminder app, running live at
**[plants.offhourslab.com](https://plants.offhourslab.com)**. Installs to the
iOS home screen as a PWA and sends real push notifications — no App Store, no
subscription, no native app.

## What it does

- Search a plant species (via [Perenual](https://perenual.com)), add it to a
  collection, give it a nickname
- Per-plant watering intervals, seeded from species data, overridable by hand
- Fertilizing schedule that pauses automatically outside the growing season
  (March–September)
- Seasonal watering adjustment: intervals stretch 1.5× in winter, 1.25× in
  the shoulder months
- One daily push notification listing everything that needs care — silent
  when nothing is due
- Tap the notification, check things off

By design this is a to-do list with a botanical seed value and a scheduler,
nothing more.

## Stack

Deliberately minimal — 2 runtime dependencies:

| Layer     | Choice                                     |
| --------- | ------------------------------------------ |
| Runtime   | Node 20+, bare `node:http`, ESM, no framework |
| Database  | SQLite via `better-sqlite3` (single file, WAL) |
| Push      | `web-push` (VAPID — works with iOS 16.4+, no Apple dev account) |
| Email     | [Resend](https://resend.com) API (login codes), raw `fetch` |
| Frontend  | One HTML file + vanilla JS, no build step  |
| Scheduler | In-process hourly `setTimeout` loop        |
| Tests     | `node:test`                                 |

## Layout

```
server/          backend
  index.js       HTTP server, routing, static files
  db.js          schema + connection (source of truth: care_events log)
  care.js        interval math (pure functions, tested)
  auth.js        6-digit email codes → HMAC session cookies
  push.js        VAPID sends, dead-subscription cleanup
  perenual.js    species search/details, aggressive caching
  scheduler.js   daily digest, per-user timezone + notify hour
  email.js       Resend integration
public/          PWA frontend (app shell, service worker, manifest, icons)
scripts/         make-icons.mjs (icon generator), add-user.js (enrollment)
test/            unit tests for the care math
deploy/          server provisioning + app setup scripts
docs/            original build guide
```

## Local development

```bash
npm install
cp .env.example .env   # or create .env — see below
npm run dev            # http://127.0.0.1:3000
npm test
```

`.env` keys: `PERENUAL_API_KEY`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`
(generate with `npx web-push generate-vapid-keys`), `VAPID_SUBJECT`,
`SESSION_SECRET`, `SEED_EMAIL` (first user, created on boot), `TIMEZONE`,
`DB_PATH`, `PORT`, `HOST`, `COOKIE_SECURE=0` (plain-HTTP dev),
`RESEND_API_KEY`/`EMAIL_FROM` (optional — without them login codes print to
the console).

There is no self-signup: users are enrolled with
`node scripts/add-user.js <email> [timezone] [notify_hour]`.

## Deployment

Runs on a shared 1.9 GB VPS behind nginx + Let's Encrypt, following the
multi-app rules in [deploy/provision-server.sh](deploy/provision-server.sh)
(loopback-only bind on port 3001, dedicated service + deploy users,
`MemoryMax=256M`, narrow sudoers grant).

- **Setup** (idempotent): [deploy/setup-planta-notify.sh](deploy/setup-planta-notify.sh)
  creates users, the systemd unit, the nginx vhost, the certificate, the env
  file (VAPID keys generated once and never rotated — subscriptions bind to
  the public key), and the backup job.
- **CI**: push to `main` → tests → SSH deploy as `deploy-planta-notify`
  (`.github/workflows/deploy.yml`). Secrets: `DEPLOY_HOST`, `DEPLOY_USER`,
  `DEPLOY_SSH_KEY`.
- **State**: SQLite at `/var/lib/planta-notify/plants.db` — the only path the
  service can write.
- **Backups**: nightly at 03:17 UTC — dated local copies (14-day rotation)
  plus a commit to a private backups repo pushed with a write-only deploy key.
- **Secrets** live in `/etc/planta-notify/env`, never in CI.

### iOS quirks worth knowing

These cost real debugging time; they are all handled, but don't regress them:

- Push permission **must** be requested from a user tap **inside the
  installed (standalone) PWA** — not on load, not in a Safari tab
- Cookies do **not** transfer from Safari to the installed PWA, which is why
  login uses a typed 6-digit code instead of a clickable magic link
- Notifications use a fixed `tag` so they replace rather than stack, and no
  action buttons (inconsistent iOS support)
- A lapsed TLS cert kills the service worker **and** the push subscription;
  renewal is automated via `certbot.timer`
- One daily digest, never one notification per plant

The full design rationale is in
[docs/plant-reminder-pwa-setup.md](docs/plant-reminder-pwa-setup.md).

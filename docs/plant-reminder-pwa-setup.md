# Plant Care PWA — Build Guide

A self-hosted watering and fertilizing reminder app. Installs to the iOS home screen, sends real push notifications, no App Store, no subscription.

---

## 1. What this is

A single-user (or few-user) web app where she can:

- Search a plant species, add it to her collection, name it ("kitchen monstera")
- Get a per-plant watering interval seeded from Perenual, overridable by hand
- Get a fertilizing schedule that pauses in winter
- Receive one daily push notification listing what needs care today
- Tap the notification, open the app, check things off

**Scope discipline:** this is a to-do list with a botanical seed value and a scheduler. Resist adding photo galleries, growth journals, or light meters until v1 has survived a month of real use.

---

## 2. Architecture

```
┌─────────────────────────────┐
│ iPhone — home screen PWA    │
│  manifest + service worker  │
└───────────┬─────────────────┘
            │ HTTPS
┌───────────▼─────────────────┐
│ Your server                 │
│  ┌───────────────────────┐  │
│  │ App (Node/Fastify)    │  │
│  │  /api/*               │  │
│  │  static PWA files     │  │
│  └───────┬───────────────┘  │
│  ┌───────▼───────────────┐  │
│  │ SQLite                │  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │ Scheduler (node-cron) │  │
│  │  daily 09:00 local    │  │
│  └───────┬───────────────┘  │
└──────────┼──────────────────┘
           │ Web Push (VAPID)
    ┌──────▼─────────────────┐
    │ Apple / Mozilla / FCM  │
    │ push services          │
    └────────────────────────┘

Perenual API ──► species cache table (fetched once per species, never again)
```

Stack suggestion — swap freely, nothing here is load-bearing:

| Layer | Pick | Why |
|---|---|---|
| Runtime | Node 20+ | `web-push` is the best-maintained VAPID library |
| Framework | Fastify or Express | Serving ~8 routes and a static dir |
| DB | SQLite (`better-sqlite3`) | Synchronous, single file, zero ops |
| Scheduler | `node-cron` in-process | One user; a separate worker is overkill |
| Frontend | Vanilla JS + one HTML file | A build step here costs more than it saves |
| TLS | Caddy or nginx + certbot | **Mandatory** — see §9 |

---

## 3. Prerequisites

- [ ] A real domain or subdomain pointed at the server (`plants.yourdomain.com`)
- [ ] Valid TLS cert — **self-signed will not work**, iOS refuses to register service workers on untrusted origins
- [ ] Perenual API key — free tier at `perenual.com/user/developer`
- [ ] Node 20+
- [ ] Her iPhone on iOS 16.4+ (functionally guaranteed at this point)
- [ ] An SMTP account or Resend/Postmark key for the fallback channel (§10)

---

## 4. Perenual integration

### 4.1 Endpoints you need

Only two, both on the free tier:

**Species search** — for the "add a plant" autocomplete.

```
GET https://perenual.com/api/v2/species-list?key=KEY&q=monstera&indoor=1
```

Returns `{ data: [{ id, common_name, scientific_name[], default_image{...} }], total, last_page }`. The `indoor=1` filter cuts a lot of noise for a houseplant app.

**Species details** — called once, when a plant is added.

```
GET https://perenual.com/api/v2/species/details/155?key=KEY
```

The fields worth storing:

| Field | Example | Use |
|---|---|---|
| `watering_general_benchmark` | `{ value: "5-7", unit: "days" }` | **Primary interval source** |
| `watering` | `"Frequent"` | Fallback when benchmark is null |
| `cycle` | `"Perennial"` | Informational |
| `sunlight` | `["part shade"]` | Show on plant detail page |
| `poisonous_to_pets` | `false` | Worth surfacing if there's a cat |
| `default_image.thumbnail` | URL | Plant list thumbnail |
| `care_level`, `maintenance` | `"Medium"`, `"Low"` | Informational |

> `species-care-guide-list` is gated to the paid Supreme tier. Don't build against it.

### 4.2 Parsing the benchmark

`watering_general_benchmark.value` is a **string**, and it's sometimes a range, sometimes a single number, sometimes null. Handle all three:

```js
function benchmarkToDays(benchmark) {
  if (!benchmark?.value) return null;
  const nums = String(benchmark.value).match(/\d+/g);
  if (!nums) return null;
  // For a range, take the midpoint and round.
  const parsed = nums.map(Number);
  const avg = parsed.reduce((a, b) => a + b, 0) / parsed.length;
  return Math.max(1, Math.round(avg));
}
```

### 4.3 Fallback mapping

When the benchmark is missing, map the coarse `watering` enum. These are opinionated starting points for indoor pots, not botany:

```js
const WATERING_FALLBACK = {
  frequent: 4,
  average:  7,
  minimum: 14,
  none:    21,   // succulents/cacti — she should override this anyway
};
```

### 4.4 Caching — do this properly

The free tier is rate-limited and you do not want a search box hammering it.

- **Species details:** fetch once on add, write the whole JSON blob into `species_cache`, never call again. Species care data does not change.
- **Search:** debounce the input 300ms, require 3+ characters, and cache query→results in a table with a 30-day TTL. Her search vocabulary is maybe forty distinct strings, so this converges to near-zero API calls fast.
- **Failure is not fatal.** If Perenual is down or over quota, let her add the plant with a manual interval and a `species_id` of null. The app must work without the API.

---

## 5. Fertilizing — you're on your own here

**Perenual returns no fertilizer schedule data.** There is no field for it. So this part is a heuristic, and you should say so in the UI rather than implying it's species-specific science.

The rule that covers most houseplants:

```js
// Growing season, northern hemisphere.
const GROWING_SEASON = { startMonth: 3, endMonth: 9 }; // March–September

function fertilizerDue(plant, today) {
  const month = today.getMonth() + 1;
  const inSeason = month >= GROWING_SEASON.startMonth
                && month <= GROWING_SEASON.endMonth;
  if (!inSeason) return false;              // dormant — skip entirely
  return daysSince(plant.last_fertilized) >= plant.fertilize_interval_days;
}
```

Defaults: **28 days** for most foliage plants, **14 days** for fast growers and anything flowering, **skip entirely** for cacti and succulents outside peak summer. Give every plant a "don't fertilize this one" toggle — it's the single most useful override.

### Seasonal watering adjustment

Same idea, applied to water. Most houseplants want meaningfully less in winter because light and growth drop off:

```js
function effectiveWateringInterval(plant, today) {
  const month = today.getMonth() + 1;
  const winter = month === 12 || month <= 2;
  const shoulder = month === 11 || month === 3;
  const multiplier = winter ? 1.5 : shoulder ? 1.25 : 1.0;
  return Math.round(plant.water_interval_days * multiplier);
}
```

Store the base interval, apply the multiplier at read time. That way when she edits the interval she's editing one number, not fighting a seasonal adjustment baked into the stored value.

---

## 6. Data model

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  login_token   TEXT,              -- magic-link token, nullable
  token_expires INTEGER,
  timezone      TEXT DEFAULT 'America/Los_Angeles',
  notify_hour   INTEGER DEFAULT 9,
  created_at    INTEGER NOT NULL
);

CREATE TABLE species_cache (
  perenual_id   INTEGER PRIMARY KEY,
  common_name   TEXT,
  scientific    TEXT,
  thumbnail_url TEXT,
  water_days    INTEGER,           -- parsed benchmark, nullable
  raw_json      TEXT,              -- full response, for later use
  fetched_at    INTEGER NOT NULL
);

CREATE TABLE plants (
  id                      INTEGER PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname                TEXT NOT NULL,
  perenual_id             INTEGER REFERENCES species_cache(perenual_id),
  location                TEXT,                    -- 'bedroom windowsill'
  water_interval_days     INTEGER NOT NULL,        -- base, pre-seasonal
  fertilize_interval_days INTEGER,                 -- NULL = never fertilize
  last_watered            INTEGER,                 -- unix seconds
  last_fertilized         INTEGER,
  archived_at             INTEGER,                 -- soft delete
  created_at              INTEGER NOT NULL
);

CREATE TABLE care_events (
  id         INTEGER PRIMARY KEY,
  plant_id   INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('water','fertilize','repot','note')),
  occurred_at INTEGER NOT NULL,
  note       TEXT
);

CREATE TABLE push_subscriptions (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      TEXT UNIQUE NOT NULL,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL,
  last_success  INTEGER,
  fail_count    INTEGER DEFAULT 0
);

CREATE INDEX idx_plants_user ON plants(user_id) WHERE archived_at IS NULL;
CREATE INDEX idx_events_plant ON care_events(plant_id, occurred_at DESC);
```

Two decisions worth calling out:

- **`care_events` is the source of truth; `last_watered` is a denormalized cache.** Update both in the same transaction. The event log costs nothing and means you can later answer "am I overwatering the fern" without having planned for it.
- **Soft-delete plants.** She will remove a plant, then want it back. `archived_at` makes that a one-line fix instead of a restore-from-backup.

---

## 7. API surface

| Method | Route | Notes |
|---|---|---|
| `POST` | `/api/auth/request` | Email a magic link |
| `GET` | `/api/auth/verify?token=` | Set session cookie, redirect to app |
| `GET` | `/api/plants` | List with computed `next_water_due`, `next_feed_due` |
| `POST` | `/api/plants` | `{ nickname, perenual_id?, water_interval_days?, ... }` |
| `PATCH` | `/api/plants/:id` | Edit intervals, nickname, location |
| `DELETE` | `/api/plants/:id` | Sets `archived_at` |
| `POST` | `/api/plants/:id/care` | `{ kind: 'water' \| 'fertilize' }` — logs event, resets timer |
| `POST` | `/api/care/bulk` | `{ plantIds: [], kind }` — the "watered everything" button |
| `GET` | `/api/species/search?q=` | Proxies Perenual, **never expose the key clientside** |
| `POST` | `/api/push/subscribe` | Store subscription |
| `POST` | `/api/push/test` | Fire one immediately — you'll use this constantly |

Auth: magic link over email. No passwords, two users, done. Session cookie `Secure; HttpOnly; SameSite=Lax` with a long expiry — she should never see a login screen after setup.

---

## 8. Web push

### 8.1 Generate VAPID keys, once

```bash
npm i web-push
npx web-push generate-vapid-keys
```

Put both in `.env`. The public key ships to the client; the private key never leaves the server.

```
VAPID_PUBLIC_KEY=BN...
VAPID_PRIVATE_KEY=xY...
VAPID_SUBJECT=mailto:you@yourdomain.com
```

No Apple Developer account, no $99, no APNs certificates. Apple's push endpoint accepts standard VAPID like every other browser.

### 8.2 `manifest.json`

```json
{
  "name": "Plant Care",
  "short_name": "Plants",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a2f23",
  "theme_color": "#1a2f23",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-180.png", "sizes": "180x180", "type": "image/png", "purpose": "any" }
  ]
}
```

`display: standalone` is **required** — iOS will not grant push to a home screen shortcut that opens in a browser chrome. Also add `<link rel="apple-touch-icon" href="/icons/icon-180.png">` in the HTML head; iOS still prefers it over the manifest for the home screen icon.

### 8.3 Subscribing — the gesture rule

The permission prompt must fire from a direct tap **inside the installed app**. Not on page load, not from a `useEffect`, not from the Safari tab. If you call it anywhere else it silently fails, and iOS gives you no error worth reading.

```js
// Only render the button when it can actually work.
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                  || window.navigator.standalone === true;

async function enableReminders() {
  const reg = await navigator.serviceWorker.register('/sw.js');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: permission };

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub),
  });
  return { ok: true };
}
```

If `isStandalone` is false on iOS, don't show a broken button — show install instructions instead (§11.1).

### 8.4 Service worker

```js
// sw.js
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Plant care', {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: 'daily-care',        // replaces yesterday's, never stacks up
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow(event.notification.data.url);
    })
  );
});
```

Two things not to do:

- **Don't use notification action buttons.** iOS support is inconsistent enough that the "Watered ✓" button will work on your Android test device and quietly not render on her phone. Tapping the notification opens a checklist — same tap count.
- **Don't send a silent push.** `userVisibleOnly: true` is not optional, and if you push without showing a notification, browsers will revoke the subscription after a few offenses.

### 8.5 Sending, with dead-subscription cleanup

```js
const webpush = require('web-push');
webpush.setVapidDetails(process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

async function sendPush(sub, payload) {
  try {
    await webpush.sendNotification({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    }, JSON.stringify(payload));

    db.prepare(`UPDATE push_subscriptions
                SET last_success = ?, fail_count = 0 WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000), sub.id);
    return true;

  } catch (err) {
    // 404/410 = subscription is permanently dead. Delete it.
    if (err.statusCode === 404 || err.statusCode === 410) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      return false;
    }
    // Anything else is likely transient (429, 5xx). Count it, keep it.
    db.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?')
      .run(sub.id);
    return false;
  }
}
```

---

## 9. Scheduler

One cron, one notification per day, one message.

```js
const cron = require('node-cron');

// Every hour; fire for users whose local hour matches their notify_hour.
cron.schedule('0 * * * *', async () => {
  const users = db.prepare('SELECT * FROM users').all();
  for (const user of users) {
    const localHour = new Date().toLocaleString('en-US', {
      timeZone: user.timezone, hour: 'numeric', hour12: false,
    });
    if (Number(localHour) !== user.notify_hour) continue;
    await notifyUser(user);
  }
});

async function notifyUser(user) {
  const due = getDuePlants(user.id);   // applies seasonal multiplier + fertilizer season
  if (due.water.length === 0 && due.feed.length === 0) return;  // silence is a feature

  const parts = [];
  if (due.water.length) parts.push(`Water: ${listNames(due.water)}`);
  if (due.feed.length)  parts.push(`Feed: ${listNames(due.feed)}`);

  const payload = {
    title: due.water.length + due.feed.length === 1
      ? `${(due.water[0] ?? due.feed[0]).nickname} needs care`
      : `${due.water.length + due.feed.length} plants need care`,
    body: parts.join(' · '),
    url: '/?filter=due',
  };

  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(user.id);
  const results = await Promise.all(subs.map((s) => sendPush(s, payload)));

  // Nothing got through — fall back to email (§10).
  if (subs.length === 0 || !results.some(Boolean)) {
    await sendCareEmail(user, due);
  }
}

function listNames(plants) {
  const names = plants.map((p) => p.nickname);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
}
```

**Digest, not one-per-plant.** Ten separate notifications on a Saturday morning is how this app gets its permission revoked. One message, everything in it.

**Silence when nothing is due.** No "all good!" notification. The absence of a notification is the message.

---

## 10. The email fallback

iOS push subscriptions are more fragile than Android's — they can drop when the app sits unused for a long stretch, when the icon is deleted and re-added, or after a device restore. For a watering reminder the failure mode is silent: no notification arrives, and nobody notices until something wilts.

The insurance is small:

- Scheduler already detects "no live subscriptions or all sends failed" (§9)
- On that condition, send a plain-text email with the same list
- Separately: if `last_success` on every subscription is older than 10 days, email her a "reminders may have stopped — open the app to reconnect" nudge

Roughly twenty lines. It's the difference between a system that fails loudly and one that fails silently.

---

## 11. Frontend

Three screens. That's the whole app.

**Today** — the default view. Plants due for water or food, each with a checkbox. A "Log all" button at the bottom. When nothing is due, the empty state should say something useful, not just "no items": *"Nothing needs care today. Next up: kitchen monstera, Thursday."*

**Collection** — every plant, sorted by next-due. Tap for detail: species info from the cache, interval editors, care history, archive button.

**Add plant** — search box hitting `/api/species/search`, results with thumbnails, tap to select. Then nickname, location, and the pre-filled intervals she can adjust. Always allow "add without a species" — sometimes she just knows it's a pothos.

Copy notes: name buttons for what they do and keep the name consistent through the flow. The button says "Log watering," the toast says "Watered." Not "Submit" / "Success." Errors should say what broke and what to do about it — "Couldn't reach the plant database. Add it manually and we'll fill in details later" beats "Error fetching species."

### 11.1 The install instructions screen

This is the highest-risk step in the whole project, because it's the one you can't debug over her shoulder. Detect iOS + non-standalone and show explicit steps:

> 1. Tap the Share button at the bottom of Safari
> 2. Scroll down, tap **Add to Home Screen**
> 3. Tap **Add**
> 4. Open Plants from your home screen — not from Safari
> 5. Tap **Turn on reminders**

Add-to-Home-Screen is a **Safari** action. If she opens your link from Messages, Instagram, or any in-app browser, the option is missing or degraded. Tell her to open it in Safari first, in those words.

---

## 12. Deployment

Caddy is the shortest path to a valid cert, which is the one non-negotiable requirement:

```
plants.yourdomain.com {
    reverse_proxy localhost:3000
    encode gzip
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
    }
}
```

Systemd unit, `Restart=always`. Nightly `sqlite3 plants.db ".backup /backups/plants-$(date +%F).db"` on a 14-day rotation — the DB is a few hundred KB, keep as many as you like.

Cert renewal matters more than usual here: **if the cert lapses, the service worker unregisters and the push subscription dies.** Caddy renews automatically; if you go the certbot route, monitor it.

---

## 13. Test checklist

Order matters — each step depends on the previous one working.

- [ ] `curl` the Perenual search and details endpoints, confirm your key works
- [ ] `benchmarkToDays` handles `"5-7"`, `"7"`, `null`, and a missing object
- [ ] Site loads over HTTPS with a valid cert (check on the phone, not just desktop)
- [ ] `manifest.json` serves as `application/manifest+json`
- [ ] Service worker registers — check Safari's Web Inspector attached to the phone
- [ ] Add to Home Screen from Safari, icon looks right
- [ ] Open from home screen, confirm no browser chrome
- [ ] Tap "Turn on reminders," permission prompt appears
- [ ] Subscription row lands in the DB with a `web.push.apple.com` endpoint
- [ ] `POST /api/push/test` — notification arrives on the lock screen
- [ ] Tapping it opens the app to the Today view
- [ ] Backdate a plant's `last_watered`, run the scheduler manually, verify it appears
- [ ] Log watering, confirm the timer resets and it drops off Today
- [ ] Delete the subscription row, run the scheduler, confirm the email fallback fires
- [ ] Set `notify_hour` to the next hour and let the real cron fire unattended

---

## 14. Build order

1. **DB + care logging, no UI** — curl your way through add/water/list. Get the interval math right first.
2. **Push, hardcoded** — one plant, one subscription, one test notification to her actual phone. This is the step most likely to surprise you; do it before building anything pretty.
3. **The three screens** — plainest possible HTML.
4. **Perenual search + seeding.**
5. **Scheduler, seasonal logic, email fallback.**
6. **Polish.**

Steps 1–2 are the project. If push works reliably to her phone on day one, the rest is CRUD.

---

## 15. Known gotchas

| Thing | What happens | Fix |
|---|---|---|
| Self-signed cert | Service worker won't register, no useful error | Real cert, no exceptions |
| Permission requested on page load | Silently fails on iOS | Must come from a tap |
| Requested from Safari tab | Silently fails | Must be in the installed app |
| Link opened in an in-app browser | No Add to Home Screen option | Route her to Safari |
| Notification action buttons | Inconsistent on iOS | Tap-to-open a checklist instead |
| Ten notifications on Saturday | Permission gets revoked | One daily digest |
| Perenual quota exhausted | Add-plant flow breaks | Cache hard, degrade to manual entry |
| Push subscription silently dies | Nothing arrives, nobody notices | Track `last_success`, email fallback |
| Cert expires | Subscription dies with it | Automated renewal + monitoring |

---

## 16. Later, if it survives

- Photo per plant, stored on disk, shown in the list
- Weather-aware adjustment — skip watering after humid stretches
- Repotting reminders on a 12–18 month interval
- Vacation mode: pause notifications, show a printable care sheet for whoever's plant-sitting
- Export to `.ics` so the schedule shows up in her calendar too

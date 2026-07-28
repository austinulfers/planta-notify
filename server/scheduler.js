import { db } from './db.js';
import { getDuePlants, listNames } from './care.js';
import { pushToUser } from './push.js';

// Hourly tick, aligned to the top of the hour (+5s of slack). For each user
// whose local hour matches their notify_hour, send one digest — or nothing.
// users.last_digest_date guards against double-sends across restarts.

function localParts(timezone, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
  };
}

export async function runDigestTick(date = new Date()) {
  const users = db.prepare('SELECT * FROM users').all();
  for (const user of users) {
    let local;
    try {
      local = localParts(user.timezone || 'America/Los_Angeles', date);
    } catch {
      local = localParts('America/Los_Angeles', date);
    }
    if (local.hour !== (user.notify_hour ?? 9)) continue;
    if (user.last_digest_date === local.date) continue; // already sent today

    // Mark first: a crash mid-send shouldn't spam on restart.
    db.prepare('UPDATE users SET last_digest_date = ? WHERE id = ?').run(
      local.date,
      user.id
    );

    const due = getDuePlants(db, user.id, date);
    if (due.water.length === 0 && due.feed.length === 0) continue; // silence is a feature

    const parts = [];
    if (due.water.length) parts.push(`Water: ${listNames(due.water)}`);
    if (due.feed.length) parts.push(`Feed: ${listNames(due.feed)}`);

    const total = due.water.length + due.feed.length;
    const payload = {
      title:
        total === 1
          ? `${(due.water[0] ?? due.feed[0]).nickname} needs care`
          : `${total} plants need care`,
      body: parts.join(' · '),
      url: '/?filter=due',
    };

    const { attempted, delivered } = await pushToUser(user.id, payload);
    console.log(
      `[digest] ${user.email}: ${total} due, ${delivered}/${attempted} pushes delivered`
    );
    if (attempted === 0 || delivered === 0) {
      // Email fallback deferred for v1 — leave a loud trace instead.
      console.error(
        `[digest] NO DELIVERY for ${user.email} — push subscriptions missing or all failed`
      );
    }
  }
}

export function startScheduler() {
  const tick = async () => {
    try {
      await runDigestTick();
    } catch (err) {
      console.error('[digest] tick failed:', err);
    }
    schedule();
  };
  const schedule = () => {
    const nowMs = Date.now();
    const nextHour = Math.ceil(nowMs / 3600_000) * 3600_000 + 5000;
    setTimeout(tick, nextHour - nowMs).unref();
  };
  schedule();
  console.log('[digest] scheduler armed (hourly)');
}

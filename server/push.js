import webpush from 'web-push';
import { db, now } from './db.js';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;

export function saveSubscription(userId, sub, userAgent) {
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent,
       fail_count = 0`
  ).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent || null, now());
}

export async function sendPush(sub, payload) {
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      JSON.stringify(payload)
    );
    db.prepare(
      'UPDATE push_subscriptions SET last_success = ?, fail_count = 0 WHERE id = ?'
    ).run(now(), sub.id);
    return true;
  } catch (err) {
    // 404/410 = subscription is permanently dead. Delete it.
    if (err.statusCode === 404 || err.statusCode === 410) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      console.log(`[push] deleted dead subscription ${sub.id}`);
      return false;
    }
    // Anything else is likely transient (429, 5xx). Count it, keep it.
    db.prepare(
      'UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?'
    ).run(sub.id);
    console.error(`[push] send failed for sub ${sub.id}: ${err.statusCode || err.message}`);
    return false;
  }
}

export async function pushToUser(userId, payload) {
  const subs = db
    .prepare('SELECT * FROM push_subscriptions WHERE user_id = ?')
    .all(userId);
  const results = await Promise.all(subs.map((s) => sendPush(s, payload)));
  return { attempted: subs.length, delivered: results.filter(Boolean).length };
}

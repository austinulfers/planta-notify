// Add (or update) a user. Run on the server as the service environment:
//   sudo -u planta-notify env $(cat /etc/planta-notify/env | xargs) \
//     node scripts/add-user.js her@email.com [timezone] [notify_hour]
import { db } from '../server/db.js';

const [email, timezone = 'America/Los_Angeles', notifyHour = '9'] = process.argv.slice(2);
if (!email || !email.includes('@')) {
  console.error('usage: node scripts/add-user.js <email> [timezone] [notify_hour]');
  process.exit(1);
}

const normalized = email.trim().toLowerCase();
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
if (existing) {
  db.prepare('UPDATE users SET timezone = ?, notify_hour = ? WHERE id = ?')
    .run(timezone, Number(notifyHour), existing.id);
  console.log(`updated ${normalized} (tz=${timezone}, hour=${notifyHour})`);
} else {
  db.prepare(
    'INSERT INTO users (email, timezone, notify_hour, created_at) VALUES (?, ?, ?, unixepoch())'
  ).run(normalized, timezone, Number(notifyHour));
  console.log(`added ${normalized} (tz=${timezone}, hour=${notifyHour})`);
}

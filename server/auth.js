import crypto from 'node:crypto';
import { db, now } from './db.js';
import { sendLoginCode } from './email.js';

// Auth = 6-digit login code, typed inside the app. This avoids the iOS
// gotcha where cookies set in Safari do NOT carry into the installed PWA
// (separate storage partitions) — a clickable magic link would log in the
// Safari tab, not the home-screen app. Email sending is deferred for v1;
// codes land in journalctl and are relayed out-of-band.
//
// Sessions are stateless HMAC tokens: "userId.expiry.hmac". No session
// table, nothing to prune, survives restarts as long as SESSION_SECRET
// is stable.

const SECRET = process.env.SESSION_SECRET;
if (!SECRET) throw new Error('SESSION_SECRET is required');

const CODE_TTL = 15 * 60; // seconds
const SESSION_TTL = 365 * 24 * 3600; // she should never see a login screen again
const COOKIE_NAME = 'planta_session';
const SECURE = process.env.COOKIE_SECURE !== '0';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s) =>
  crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

export async function requestLoginCode(email) {
  const user = db
    .prepare('SELECT id, email FROM users WHERE email = ?')
    .get(String(email || '').trim().toLowerCase());
  // Don't reveal whether the account exists; no-op silently.
  if (!user) return;

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  db.prepare('UPDATE users SET login_token = ?, token_expires = ? WHERE id = ?')
    .run(sha256(code), now() + CODE_TTL, user.id);

  const emailed = await sendLoginCode(user.email, code);
  if (emailed) {
    console.log(`[auth] login code emailed to ${user.email}`);
  } else {
    // No email configured (dev) or send failed — the journal is the fallback.
    console.log(`[auth] login code for ${user.email}: ${code} (valid 15 min)`);
  }
}

export function verifyLoginCode(email, code) {
  const user = db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(String(email || '').trim().toLowerCase());
  if (!user || !user.login_token || !user.token_expires) return null;
  if (user.token_expires < now()) return null;
  const given = String(code || '').trim();
  if (!/^\d{6}$/.test(given)) return null;
  const a = Buffer.from(sha256(given));
  const b = Buffer.from(user.login_token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Single-use.
  db.prepare('UPDATE users SET login_token = NULL, token_expires = NULL WHERE id = ?')
    .run(user.id);
  return user;
}

export function sessionCookie(userId) {
  const expires = now() + SESSION_TTL;
  const payload = `${userId}.${expires}`;
  const token = `${payload}.${hmac(payload)}`;
  return (
    `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL}; ` +
    `HttpOnly; SameSite=Lax${SECURE ? '; Secure' : ''}`
  );
}

export function userFromRequest(req) {
  const cookies = req.headers.cookie;
  if (!cookies) return null;
  const match = cookies
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const token = match.slice(COOKIE_NAME.length + 1);
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expires, sig] = parts;
  const payload = `${userId}.${expires}`;
  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expires) < now()) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId)) || null;
}

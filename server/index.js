import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, now } from './db.js';
import { requestLoginCode, verifyLoginCode, sessionCookie, userFromRequest } from './auth.js';
import { saveSubscription, pushToUser, vapidPublicKey } from './push.js';
import { searchSpecies, getSpeciesDetails } from './perenual.js';
import { nextWaterDue, nextFeedDue, waterDue, fertilizerDue } from './care.js';
import { startScheduler, runDigestTick } from './scheduler.js';
import {
  MAX_PHOTO_BYTES,
  detectImageType,
  savePhoto,
  deletePhoto,
  photoPath,
  mimeForPhoto,
  storageReady,
} from './photos.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* Photos need a far larger ceiling than JSON payloads, so they get their own
 * reader instead of raising MAX_BODY for every route. */
function readRawBody(req, max) {
  const tooLarge = () => Object.assign(new Error('Image is too large.'), { status: 413 });

  // Reject before reading a byte when the client declares an oversized body,
  // so the caller can still send a readable error instead of a dead socket.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) return Promise.reject(tooLarge());

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        // Backstop for chunked or mis-declared bodies. Pause rather than
        // destroy so the 413 response can still be written.
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function plantWithDue(p, today = new Date()) {
  return {
    ...p,
    next_water_due: nextWaterDue(p, today),
    next_feed_due: nextFeedDue(p, today),
    water_due: waterDue(p, today),
    feed_due: fertilizerDue(p, today),
  };
}

function getPlantOwned(user, id) {
  return db
    .prepare('SELECT * FROM plants WHERE id = ? AND user_id = ? AND archived_at IS NULL')
    .get(Number(id), user.id);
}

const logCare = db.transaction((plantId, kind, ts, note) => {
  db.prepare(
    'INSERT INTO care_events (plant_id, kind, occurred_at, note) VALUES (?, ?, ?, ?)'
  ).run(plantId, kind, ts, note ?? null);
  if (kind === 'water') {
    db.prepare('UPDATE plants SET last_watered = ? WHERE id = ?').run(ts, plantId);
  } else if (kind === 'fertilize') {
    db.prepare('UPDATE plants SET last_fertilized = ? WHERE id = ?').run(ts, plantId);
  }
});

// --- API routes ------------------------------------------------------------

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  // Public routes.
  if (route === 'POST /api/auth/request') {
    const body = await readBody(req);
    // Fire-and-forget: responding before the email send completes keeps the
    // response time constant whether or not the account exists.
    requestLoginCode(body.email).catch((err) => console.error('[auth]', err));
    return json(res, 200, { ok: true, message: 'If that account exists, a code was issued.' });
  }

  if (route === 'POST /api/auth/verify') {
    const body = await readBody(req);
    const user = verifyLoginCode(body.email, body.code);
    if (!user) return json(res, 401, { ok: false, error: 'Invalid or expired code.' });
    res.setHeader('Set-Cookie', sessionCookie(user.id));
    return json(res, 200, { ok: true });
  }

  // Everything below requires a session.
  const user = userFromRequest(req);
  if (!user) return json(res, 401, { ok: false, error: 'Not signed in.' });

  if (route === 'GET /api/me') {
    return json(res, 200, {
      ok: true,
      email: user.email,
      timezone: user.timezone,
      notify_hour: user.notify_hour,
      vapid_public_key: vapidPublicKey,
    });
  }

  if (route === 'GET /api/plants') {
    const today = new Date();
    const plants = db
      .prepare(
        'SELECT * FROM plants WHERE user_id = ? AND archived_at IS NULL ORDER BY created_at'
      )
      .all(user.id)
      .map((p) => plantWithDue(p, today));
    return json(res, 200, { ok: true, plants });
  }

  if (route === 'POST /api/plants') {
    const body = await readBody(req);
    const nickname = String(body.nickname || '').trim();
    if (!nickname) return json(res, 400, { ok: false, error: 'Nickname is required.' });

    let species = null;
    if (body.perenual_id) {
      // May be null if Perenual is down — plant still gets added.
      species = await getSpeciesDetails(Number(body.perenual_id));
    }

    const waterDays =
      Number(body.water_interval_days) || species?.water_days || 7;
    const fertDays =
      body.fertilize_interval_days === null
        ? null
        : Number(body.fertilize_interval_days) || 28;

    // Fresh plants start their clocks now — a new plant should not instantly
    // appear overdue — unless the caller says when it was actually last watered.
    const ts = now();
    let lastWatered = ts;
    if (body.last_watered != null) {
      const v = Number(body.last_watered);
      if (!Number.isInteger(v) || v > ts || v < ts - 5 * 365 * 86400)
        return json(res, 400, { ok: false, error: 'Last watered date must be in the past.' });
      lastWatered = v;
    }
    const info = db
      .prepare(
        `INSERT INTO plants
           (user_id, nickname, perenual_id, location, water_interval_days,
            fertilize_interval_days, last_watered, last_fertilized, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        user.id,
        nickname,
        species?.perenual_id ?? null,
        body.location ? String(body.location).trim() : null,
        waterDays,
        fertDays,
        lastWatered,
        ts,
        ts
      );
    // Keep the event log truthful: a backdated last_watered is a real watering.
    if (lastWatered !== ts) {
      db.prepare(
        'INSERT INTO care_events (plant_id, kind, occurred_at, note) VALUES (?, ?, ?, ?)'
      ).run(info.lastInsertRowid, 'water', lastWatered, 'added with backdated watering');
    }
    const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(info.lastInsertRowid);
    return json(res, 201, { ok: true, plant: plantWithDue(plant), species_found: !!species });
  }

  const plantIdMatch = url.pathname.match(/^\/api\/plants\/(\d+)(\/care)?$/);
  if (plantIdMatch) {
    const plant = getPlantOwned(user, plantIdMatch[1]);
    if (!plant) return json(res, 404, { ok: false, error: 'Plant not found.' });

    if (req.method === 'PATCH' && !plantIdMatch[2]) {
      const body = await readBody(req);
      const fields = {};
      if (body.nickname !== undefined) fields.nickname = String(body.nickname).trim();
      if (body.location !== undefined)
        fields.location = body.location ? String(body.location).trim() : null;
      if (body.water_interval_days !== undefined) {
        const v = Number(body.water_interval_days);
        if (!Number.isInteger(v) || v < 1)
          return json(res, 400, { ok: false, error: 'Watering interval must be a positive number of days.' });
        fields.water_interval_days = v;
      }
      if (body.fertilize_interval_days !== undefined) {
        if (body.fertilize_interval_days === null) {
          fields.fertilize_interval_days = null; // the "don't fertilize" toggle
        } else {
          const v = Number(body.fertilize_interval_days);
          if (!Number.isInteger(v) || v < 1)
            return json(res, 400, { ok: false, error: 'Fertilizing interval must be a positive number of days.' });
          fields.fertilize_interval_days = v;
        }
      }
      if (fields.nickname === '') return json(res, 400, { ok: false, error: 'Nickname cannot be empty.' });
      if (Object.keys(fields).length === 0) return json(res, 400, { ok: false, error: 'Nothing to update.' });

      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE plants SET ${sets} WHERE id = ?`).run(...Object.values(fields), plant.id);
      const updated = db.prepare('SELECT * FROM plants WHERE id = ?').get(plant.id);
      return json(res, 200, { ok: true, plant: plantWithDue(updated) });
    }

    if (req.method === 'DELETE' && !plantIdMatch[2]) {
      db.prepare('UPDATE plants SET archived_at = ? WHERE id = ?').run(now(), plant.id);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && plantIdMatch[2]) {
      const body = await readBody(req);
      const kind = body.kind;
      if (!['water', 'fertilize', 'repot', 'note'].includes(kind))
        return json(res, 400, { ok: false, error: 'Unknown care kind.' });
      logCare(plant.id, kind, now(), body.note);
      const updated = db.prepare('SELECT * FROM plants WHERE id = ?').get(plant.id);
      return json(res, 200, { ok: true, plant: plantWithDue(updated) });
    }
  }

  const photoMatch = url.pathname.match(/^\/api\/plants\/(\d+)\/photo$/);
  if (photoMatch) {
    const plant = getPlantOwned(user, photoMatch[1]);
    if (!plant) return json(res, 404, { ok: false, error: 'Plant not found.' });

    if (req.method === 'GET') {
      const abs = plant.photo && photoPath(plant.photo);
      if (!abs || !fs.existsSync(abs)) return json(res, 404, { ok: false, error: 'No photo.' });
      // Private: photos are per-user, so no shared cache may keep a copy.
      // Each upload gets a new filename, which is what busts the cache.
      res.writeHead(200, {
        'Content-Type': mimeForPhoto(plant.photo),
        'Cache-Control': 'private, max-age=604800',
      });
      return fs.createReadStream(abs).pipe(res);
    }

    if (req.method === 'POST') {
      if (!storageReady)
        return json(res, 503, { ok: false, error: 'Photo storage is unavailable.' });
      const buf = await readRawBody(req, MAX_PHOTO_BYTES);
      if (buf.length === 0) return json(res, 400, { ok: false, error: 'No image data.' });
      const type = detectImageType(buf);
      if (!type)
        return json(res, 415, { ok: false, error: 'Only JPEG, PNG, and WebP images are supported.' });

      const filename = savePhoto(plant.id, buf, type.ext);
      const previous = plant.photo;
      db.prepare('UPDATE plants SET photo = ? WHERE id = ?').run(filename, plant.id);
      if (previous && previous !== filename) deletePhoto(previous);
      return json(res, 200, { ok: true, photo: filename });
    }

    if (req.method === 'DELETE') {
      if (plant.photo) {
        db.prepare('UPDATE plants SET photo = NULL WHERE id = ?').run(plant.id);
        deletePhoto(plant.photo);
      }
      return json(res, 200, { ok: true });
    }
  }

  const historyMatch = url.pathname.match(/^\/api\/plants\/(\d+)\/history$/);
  if (historyMatch && req.method === 'GET') {
    const plant = getPlantOwned(user, historyMatch[1]);
    if (!plant) return json(res, 404, { ok: false, error: 'Plant not found.' });
    const events = db
      .prepare(
        'SELECT kind, occurred_at, note FROM care_events WHERE plant_id = ? ORDER BY occurred_at DESC LIMIT 50'
      )
      .all(plant.id);
    return json(res, 200, { ok: true, events });
  }

  if (route === 'POST /api/care/bulk') {
    const body = await readBody(req);
    const kind = body.kind;
    if (!['water', 'fertilize'].includes(kind))
      return json(res, 400, { ok: false, error: 'Unknown care kind.' });
    const ids = Array.isArray(body.plantIds) ? body.plantIds : [];
    const ts = now();
    let count = 0;
    for (const id of ids) {
      const plant = getPlantOwned(user, id);
      if (!plant) continue;
      logCare(plant.id, kind, ts, null);
      count++;
    }
    return json(res, 200, { ok: true, count });
  }

  if (route === 'GET /api/species/search') {
    const q = url.searchParams.get('q') || '';
    const out = await searchSpecies(q);
    return json(res, 200, { ok: true, ...out });
  }

  const speciesMatch = url.pathname.match(/^\/api\/species\/(\d+)$/);
  if (speciesMatch && req.method === 'GET') {
    // Fetched when a species is selected in the Add flow, so the watering
    // interval can prefill. Also warms species_cache ahead of plant creation.
    const species = await getSpeciesDetails(Number(speciesMatch[1]));
    if (!species) return json(res, 200, { ok: true, species: null });
    return json(res, 200, {
      ok: true,
      species: {
        perenual_id: species.perenual_id,
        common_name: species.common_name,
        water_days: species.water_days,
      },
    });
  }

  if (route === 'POST /api/push/subscribe') {
    const body = await readBody(req);
    if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth)
      return json(res, 400, { ok: false, error: 'Malformed subscription.' });
    saveSubscription(user.id, body, req.headers['user-agent']);
    return json(res, 201, { ok: true });
  }

  if (route === 'POST /api/push/test') {
    const result = await pushToUser(user.id, {
      title: 'Plant Care',
      body: 'Notification works. This is what a reminder will look like.',
      url: '/',
    });
    return json(res, 200, { ok: true, ...result });
  }

  if (route === 'POST /api/digest/run' && process.env.NODE_ENV !== 'production') {
    // Dev/test hook: force the digest logic to run right now.
    await runDigestTick();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { ok: false, error: 'No such route.' });
}

// --- Static files ----------------------------------------------------------

function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      // SPA-ish fallback: unknown non-file paths get the app shell.
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
          if (err2) {
            res.writeHead(404);
            return res.end('not found');
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(html);
        });
      }
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(abs).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (abs.endsWith('manifest.json')) headers['Content-Type'] = 'application/manifest+json';
    // The service worker and app shell must revalidate so updates roll out;
    // icons can cache for a week.
    headers['Cache-Control'] =
      ext === '.png' ? 'public, max-age=604800' : 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
}

// --- Server ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { ok: false, error: err.status ? err.message : 'Server error.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`planta-notify listening on http://${HOST}:${PORT}`);
  startScheduler();
});

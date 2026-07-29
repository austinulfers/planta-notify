/* Plant photo storage: one file per plant, on local disk.
 *
 * In production the systemd unit only grants write access to the data dir,
 * so UPLOADS_DIR must live under /var/lib/planta-notify.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* Default beside the database rather than the CWD: the code dir is read-only
 * in production, so ./uploads would be unwritable. This keeps photos working on
 * a deploy that ships new code without re-running the provisioning script. */
function defaultUploadsDir() {
  const dbPath = process.env.DB_PATH;
  return dbPath ? path.join(path.dirname(path.resolve(dbPath)), 'uploads') : './uploads';
}

export const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || defaultUploadsDir());
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/* Photos are a secondary feature; watering reminders are the point of the app.
 * An unwritable directory must degrade uploads, not crash the service at boot. */
export let storageReady = true;
try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (err) {
  storageReady = false;
  console.error(`[photos] ${UPLOADS_DIR} is not writable, uploads disabled:`, err.message);
}

/* Sniff magic bytes rather than trusting Content-Type, so a mislabelled or
 * hostile upload can't get stored and served back as something else. */
export function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function mimeForPhoto(filename) {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

/* Resolve a stored filename to an absolute path, refusing anything that isn't
 * a plain basename inside UPLOADS_DIR. */
export function photoPath(filename) {
  if (!filename || filename !== path.basename(filename)) return null;
  const abs = path.join(UPLOADS_DIR, filename);
  if (path.dirname(abs) !== UPLOADS_DIR) return null;
  return abs;
}

/* Write to a temp file then rename, so a failed upload can never leave a
 * half-written file where the DB says a valid photo lives. */
export function savePhoto(plantId, buf, ext) {
  const filename = `p${plantId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const tmp = path.join(UPLOADS_DIR, `.tmp-${filename}`);
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o640 });
    fs.renameSync(tmp, path.join(UPLOADS_DIR, filename));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return filename;
}

/* Best-effort: a leftover file is untidy but harmless, and must not fail the
 * request that replaced or removed it. */
export function deletePhoto(filename) {
  const abs = photoPath(filename);
  if (!abs) return;
  try {
    fs.rmSync(abs, { force: true });
  } catch (err) {
    console.error('[photos] could not delete', filename, err.message);
  }
}

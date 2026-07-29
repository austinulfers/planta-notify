import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// photos.js creates UPLOADS_DIR on import, so point it at a temp dir before
// the module is evaluated (hence the dynamic import).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planta-photos-'));
process.env.UPLOADS_DIR = tmpDir;
const { detectImageType, photoPath, savePhoto, deletePhoto, mimeForPhoto } =
  await import('../server/photos.js');

const MODULE = fileURLToPath(new URL('../server/photos.js', import.meta.url));

/* UPLOADS_DIR is resolved once at import, so env-dependent cases need a fresh
 * process rather than a re-import of the cached module. */
function run(env, body) {
  return execFileSync(
    process.execPath,
    ['-e', `const m = await import(${JSON.stringify(MODULE)}); ${body}`],
    { env: { ...process.env, UPLOADS_DIR: '', DB_PATH: '', ...env }, encoding: 'utf8' }
  ).trim();
}

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const pad = (header) => Buffer.concat([Buffer.from(header), Buffer.alloc(16)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(16),
]);

test('detectImageType recognises jpeg, png, and webp', () => {
  assert.deepEqual(detectImageType(JPEG), { ext: '.jpg', mime: 'image/jpeg' });
  assert.deepEqual(detectImageType(PNG), { ext: '.png', mime: 'image/png' });
  assert.deepEqual(detectImageType(WEBP), { ext: '.webp', mime: 'image/webp' });
});

test('detectImageType rejects non-images', () => {
  assert.equal(detectImageType(pad([0x47, 0x49, 0x46, 0x38])), null); // gif
  assert.equal(detectImageType(pad(Buffer.from('<?php echo 1;'))), null);
  assert.equal(detectImageType(Buffer.alloc(32)), null);
});

test('detectImageType rejects empty, tiny, and missing buffers', () => {
  assert.equal(detectImageType(Buffer.alloc(0)), null);
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff])), null);
  assert.equal(detectImageType(undefined), null);
  assert.equal(detectImageType(null), null);
});

test('photoPath refuses traversal and nested paths', () => {
  assert.equal(photoPath('../../etc/passwd'), null);
  assert.equal(photoPath('sub/dir.jpg'), null);
  assert.equal(photoPath(''), null);
  assert.equal(photoPath(null), null);
  assert.equal(photoPath('p1-123.jpg'), path.join(tmpDir, 'p1-123.jpg'));
});

test('savePhoto writes the file and leaves no temp file behind', () => {
  const filename = savePhoto(7, JPEG, '.jpg');
  assert.match(filename, /^p7-\d+-[0-9a-f]{8}\.jpg$/);
  assert.deepEqual(fs.readFileSync(path.join(tmpDir, filename)), JPEG);
  assert.equal(
    fs.readdirSync(tmpDir).some((f) => f.startsWith('.tmp-')),
    false
  );
  deletePhoto(filename);
});

test('savePhoto gives each upload a unique name', () => {
  const a = savePhoto(1, JPEG, '.jpg');
  const b = savePhoto(1, JPEG, '.jpg');
  assert.notEqual(a, b);
  deletePhoto(a);
  deletePhoto(b);
});

test('deletePhoto removes the file and ignores unknown names', () => {
  const filename = savePhoto(3, PNG, '.png');
  deletePhoto(filename);
  assert.equal(fs.existsSync(path.join(tmpDir, filename)), false);
  deletePhoto(filename); // already gone
  deletePhoto('../../etc/passwd'); // rejected by photoPath
});

test('mimeForPhoto maps extensions', () => {
  assert.equal(mimeForPhoto('p1-2.jpg'), 'image/jpeg');
  assert.equal(mimeForPhoto('p1-2.png'), 'image/png');
  assert.equal(mimeForPhoto('p1-2.webp'), 'image/webp');
  assert.equal(mimeForPhoto('p1-2.txt'), 'application/octet-stream');
});

/* The deploy pipeline ships code without re-running provisioning, so a release
 * that only sets DB_PATH must still land photos somewhere writable — the code
 * dir is read-only in production. */
test('UPLOADS_DIR defaults beside the database, not the cwd', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planta-db-'));
  const out = await run(
    { DB_PATH: path.join(dbDir, 'plants.db'), UPLOADS_DIR: '' },
    'console.log(m.UPLOADS_DIR, m.storageReady)'
  );
  assert.equal(out, `${path.join(dbDir, 'uploads')} true`);
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('an unwritable uploads dir disables uploads instead of crashing', async () => {
  const blocked = path.join(tmpDir, 'blocked');
  fs.mkdirSync(blocked, { mode: 0o500 }); // readable, not writable
  const out = await run(
    { UPLOADS_DIR: path.join(blocked, 'uploads') },
    'console.log(m.storageReady)'
  );
  assert.equal(out, 'false');
  fs.chmodSync(blocked, 0o700);
});

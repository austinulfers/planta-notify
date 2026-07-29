import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './plants.db';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  login_token   TEXT,              -- sha256 of the current login code, nullable
  token_expires INTEGER,
  timezone      TEXT DEFAULT 'America/Los_Angeles',
  notify_hour   INTEGER DEFAULT 9,
  last_digest_date TEXT,           -- YYYY-MM-DD in user tz; guards double-sends
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS species_cache (
  perenual_id   INTEGER PRIMARY KEY,
  common_name   TEXT,
  scientific    TEXT,
  thumbnail_url TEXT,
  water_days    INTEGER,           -- parsed benchmark, nullable
  raw_json      TEXT,              -- full response, for later use
  fetched_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS search_cache (
  query      TEXT PRIMARY KEY,
  results    TEXT NOT NULL,        -- JSON array
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plants (
  id                      INTEGER PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname                TEXT NOT NULL,
  perenual_id             INTEGER REFERENCES species_cache(perenual_id),
  location                TEXT,
  water_interval_days     INTEGER NOT NULL,        -- base, pre-seasonal
  fertilize_interval_days INTEGER,                 -- NULL = never fertilize
  last_watered            INTEGER,                 -- unix seconds
  last_fertilized         INTEGER,
  photo                   TEXT,                    -- uploaded photo filename, relative to UPLOADS_DIR
  archived_at             INTEGER,                 -- soft delete
  created_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS care_events (
  id          INTEGER PRIMARY KEY,
  plant_id    INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('water','fertilize','repot','note')),
  occurred_at INTEGER NOT NULL,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
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

CREATE INDEX IF NOT EXISTS idx_plants_user ON plants(user_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_plant ON care_events(plant_id, occurred_at DESC);
`);

// Migrations. CREATE TABLE IF NOT EXISTS leaves existing tables alone, so
// columns added after a deploy need an explicit guarded ALTER TABLE.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Migrated: ${table}.${column} added`);
  }
}
addColumn('plants', 'photo', 'TEXT');

// Seed the first user so login works before any signup flow exists.
const seedEmail = process.env.SEED_EMAIL;
if (seedEmail && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(seedEmail)) {
  db.prepare(
    'INSERT INTO users (email, timezone, notify_hour, created_at) VALUES (?, ?, 9, unixepoch())'
  ).run(seedEmail, process.env.TIMEZONE || 'America/Los_Angeles');
  console.log(`Seeded user ${seedEmail}`);
}

export const now = () => Math.floor(Date.now() / 1000);

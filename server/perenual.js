import { db, now } from './db.js';
import { benchmarkToDays, wateringEnumToDays } from './care.js';

// Perenual free tier is rate-limited: cache hard, degrade gracefully.
// - search: query -> results cached 30 days
// - details: fetched once per species on plant-add, cached forever

const API = 'https://perenual.com/api/v2';
const KEY = process.env.PERENUAL_API_KEY;
const SEARCH_TTL = 30 * 24 * 3600;

// The free tier returns a paywall placeholder image for many species; a
// broken/locked thumbnail is worse than none.
function usableThumb(url) {
  return url && !url.includes('upgrade_access') ? url : null;
}

export async function searchSpecies(q) {
  const query = q.trim().toLowerCase();
  if (query.length < 3) return { results: [], cached: true };

  const hit = db.prepare('SELECT * FROM search_cache WHERE query = ?').get(query);
  if (hit && now() - hit.fetched_at < SEARCH_TTL) {
    return { results: JSON.parse(hit.results), cached: true };
  }

  if (!KEY) return { results: [], error: 'no-api-key' };

  let json;
  try {
    const res = await fetch(
      `${API}/species-list?key=${KEY}&q=${encodeURIComponent(query)}&indoor=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`perenual ${res.status}`);
    json = await res.json();
  } catch (err) {
    console.error(`[perenual] search failed: ${err.message}`);
    // Failure is not fatal: stale cache beats nothing.
    if (hit) return { results: JSON.parse(hit.results), cached: true, stale: true };
    return { results: [], error: 'unavailable' };
  }

  const results = (json.data || []).slice(0, 12).map((s) => ({
    id: s.id,
    common_name: s.common_name,
    scientific_name: Array.isArray(s.scientific_name)
      ? s.scientific_name[0]
      : s.scientific_name,
    thumbnail: usableThumb(s.default_image?.thumbnail),
  }));

  db.prepare(
    `INSERT INTO search_cache (query, results, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(query) DO UPDATE SET results = excluded.results, fetched_at = excluded.fetched_at`
  ).run(query, JSON.stringify(results), now());

  return { results, cached: false };
}

// Returns a species_cache row (fetching + caching if needed), or null if the
// API is unreachable — the caller must let the plant be added anyway.
export async function getSpeciesDetails(perenualId) {
  const cached = db
    .prepare('SELECT * FROM species_cache WHERE perenual_id = ?')
    .get(perenualId);
  if (cached) return cached;

  if (!KEY) return null;

  let s;
  try {
    const res = await fetch(`${API}/species/details/${perenualId}?key=${KEY}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`perenual ${res.status}`);
    s = await res.json();
  } catch (err) {
    console.error(`[perenual] details failed for ${perenualId}: ${err.message}`);
    return null;
  }

  const waterDays =
    benchmarkToDays(s.watering_general_benchmark) ?? wateringEnumToDays(s.watering);

  db.prepare(
    `INSERT OR REPLACE INTO species_cache
       (perenual_id, common_name, scientific, thumbnail_url, water_days, raw_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    s.id,
    s.common_name || null,
    Array.isArray(s.scientific_name) ? s.scientific_name[0] : s.scientific_name || null,
    usableThumb(s.default_image?.thumbnail),
    waterDays,
    JSON.stringify(s),
    now()
  );

  return db.prepare('SELECT * FROM species_cache WHERE perenual_id = ?').get(s.id);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  benchmarkToDays,
  wateringEnumToDays,
  effectiveWateringInterval,
  waterDue,
  fertilizerDue,
  nextFeedDue,
  listNames,
} from '../server/care.js';

const DAY = 86400;
const unix = (d) => Math.floor(d.getTime() / 1000);

test('benchmarkToDays handles a range', () => {
  assert.equal(benchmarkToDays({ value: '5-7', unit: 'days' }), 6);
});

test('benchmarkToDays handles a single number', () => {
  assert.equal(benchmarkToDays({ value: '7', unit: 'days' }), 7);
});

test('benchmarkToDays handles null value', () => {
  assert.equal(benchmarkToDays({ value: null }), null);
});

test('benchmarkToDays handles missing object', () => {
  assert.equal(benchmarkToDays(undefined), null);
  assert.equal(benchmarkToDays(null), null);
});

test('benchmarkToDays handles junk strings', () => {
  assert.equal(benchmarkToDays({ value: 'often' }), null);
});

test('benchmarkToDays handles embedded quotes (real API shape)', () => {
  // Perenual actually returns e.g. '"7-10"' for weeping fig.
  assert.equal(benchmarkToDays({ value: '"7-10"', unit: 'days' }), 9);
});

test('benchmarkToDays never returns less than 1', () => {
  assert.equal(benchmarkToDays({ value: '0' }), 1);
});

test('wateringEnumToDays maps known values case-insensitively', () => {
  assert.equal(wateringEnumToDays('Frequent'), 4);
  assert.equal(wateringEnumToDays('average'), 7);
  assert.equal(wateringEnumToDays('Minimum'), 14);
  assert.equal(wateringEnumToDays('NONE'), 21);
  assert.equal(wateringEnumToDays('mystery'), null);
  assert.equal(wateringEnumToDays(null), null);
});

test('effectiveWateringInterval applies seasonal multipliers', () => {
  const plant = { water_interval_days: 8 };
  assert.equal(effectiveWateringInterval(plant, new Date(2026, 0, 15)), 12); // Jan: 1.5x
  assert.equal(effectiveWateringInterval(plant, new Date(2026, 11, 15)), 12); // Dec: 1.5x
  assert.equal(effectiveWateringInterval(plant, new Date(2026, 2, 15)), 10); // Mar: 1.25x
  assert.equal(effectiveWateringInterval(plant, new Date(2026, 10, 15)), 10); // Nov: 1.25x
  assert.equal(effectiveWateringInterval(plant, new Date(2026, 6, 15)), 8); // Jul: 1x
});

test('waterDue respects the seasonal interval', () => {
  const july = new Date(2026, 6, 15, 12);
  const plant = { water_interval_days: 7, last_watered: unix(july) - 7 * DAY };
  assert.equal(waterDue(plant, july), true);

  const jan = new Date(2026, 0, 15, 12);
  const plantJan = { water_interval_days: 7, last_watered: unix(jan) - 8 * DAY };
  // Jan interval is round(7*1.5)=11 — 8 days ago is not yet due.
  assert.equal(waterDue(plantJan, jan), false);
});

test('waterDue is true when never watered', () => {
  assert.equal(waterDue({ water_interval_days: 7, last_watered: null }), true);
});

test('fertilizerDue skips dormant season entirely', () => {
  const jan = new Date(2026, 0, 15, 12);
  const plant = {
    fertilize_interval_days: 28,
    last_fertilized: unix(jan) - 90 * DAY,
  };
  assert.equal(fertilizerDue(plant, jan), false);
});

test('fertilizerDue fires in season after the interval', () => {
  const july = new Date(2026, 6, 15, 12);
  const plant = {
    fertilize_interval_days: 28,
    last_fertilized: unix(july) - 30 * DAY,
  };
  assert.equal(fertilizerDue(plant, july), true);
});

test('fertilizerDue is false when interval is null (never fertilize)', () => {
  const july = new Date(2026, 6, 15, 12);
  assert.equal(
    fertilizerDue({ fertilize_interval_days: null, last_fertilized: null }, july),
    false
  );
});

test('nextFeedDue rolls a dormant-season due date to March 1', () => {
  // Last fed Oct 20, 28-day interval → lands Nov 17 (dormant) → next Mar 1.
  const lastFed = unix(new Date(2026, 9, 20, 12));
  const due = nextFeedDue(
    { fertilize_interval_days: 28, last_fertilized: lastFed },
    new Date(2026, 9, 21)
  );
  const d = new Date(due * 1000);
  assert.equal(d.getMonth(), 2); // March
  assert.equal(d.getDate(), 1);
  assert.equal(d.getFullYear(), 2027);
});

test('nextFeedDue is null when fertilizing is off', () => {
  assert.equal(nextFeedDue({ fertilize_interval_days: null }), null);
});

test('listNames truncates past three', () => {
  const p = (n) => ({ nickname: n });
  assert.equal(listNames([p('a')]), 'a');
  assert.equal(listNames([p('a'), p('b'), p('c')]), 'a, b, c');
  assert.equal(listNames([p('a'), p('b'), p('c'), p('d')]), 'a, b +2 more');
});

// Interval math. Pure functions; date passed in for testability.

// Perenual's watering_general_benchmark.value is a string: "5-7", "7", or null.
export function benchmarkToDays(benchmark) {
  if (!benchmark?.value) return null;
  const nums = String(benchmark.value).match(/\d+/g);
  if (!nums) return null;
  const parsed = nums.map(Number);
  const avg = parsed.reduce((a, b) => a + b, 0) / parsed.length;
  return Math.max(1, Math.round(avg));
}

// When the benchmark is missing, map the coarse `watering` enum.
// Opinionated starting points for indoor pots, not botany.
export const WATERING_FALLBACK = {
  frequent: 4,
  average: 7,
  minimum: 14,
  none: 21, // succulents/cacti — should be overridden anyway
};

export function wateringEnumToDays(watering) {
  if (!watering) return null;
  return WATERING_FALLBACK[String(watering).toLowerCase()] ?? null;
}

// Growing season, northern hemisphere: March–September.
export const GROWING_SEASON = { startMonth: 3, endMonth: 9 };

// Most houseplants want meaningfully less water in winter.
export function effectiveWateringInterval(plant, today = new Date()) {
  const month = today.getMonth() + 1;
  const winter = month === 12 || month <= 2;
  const shoulder = month === 11 || month === 3;
  const multiplier = winter ? 1.5 : shoulder ? 1.25 : 1.0;
  return Math.round(plant.water_interval_days * multiplier);
}

const DAY = 86400;

export function waterDue(plant, today = new Date()) {
  if (plant.last_watered == null) return true;
  const interval = effectiveWateringInterval(plant, today);
  const days = (today.getTime() / 1000 - plant.last_watered) / DAY;
  return days >= interval;
}

export function fertilizerDue(plant, today = new Date()) {
  if (plant.fertilize_interval_days == null) return false; // "never fertilize" toggle
  const month = today.getMonth() + 1;
  const inSeason =
    month >= GROWING_SEASON.startMonth && month <= GROWING_SEASON.endMonth;
  if (!inSeason) return false; // dormant — skip entirely
  if (plant.last_fertilized == null) return true;
  const days = (today.getTime() / 1000 - plant.last_fertilized) / DAY;
  return days >= plant.fertilize_interval_days;
}

// Next-due unix seconds, for display/sorting. Fertilizer due date rolls
// forward into the growing season when it lands in dormancy.
export function nextWaterDue(plant, today = new Date()) {
  const interval = effectiveWateringInterval(plant, today);
  if (plant.last_watered == null) return Math.floor(today.getTime() / 1000);
  return plant.last_watered + interval * DAY;
}

export function nextFeedDue(plant, today = new Date()) {
  if (plant.fertilize_interval_days == null) return null;
  const base =
    plant.last_fertilized == null
      ? Math.floor(today.getTime() / 1000)
      : plant.last_fertilized + plant.fertilize_interval_days * DAY;
  const d = new Date(base * 1000);
  const month = d.getMonth() + 1;
  if (month >= GROWING_SEASON.startMonth && month <= GROWING_SEASON.endMonth) {
    return base;
  }
  // Dormant — roll to March 1 of the appropriate year.
  const year = d.getFullYear() + (month > GROWING_SEASON.endMonth ? 1 : 0);
  return Math.floor(new Date(year, GROWING_SEASON.startMonth - 1, 1).getTime() / 1000);
}

export function getDuePlants(db, userId, today = new Date()) {
  const plants = db
    .prepare('SELECT * FROM plants WHERE user_id = ? AND archived_at IS NULL')
    .all(userId);
  return {
    water: plants.filter((p) => waterDue(p, today)),
    feed: plants.filter((p) => fertilizerDue(p, today)),
  };
}

export function listNames(plants) {
  const names = plants.map((p) => p.nickname);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
}

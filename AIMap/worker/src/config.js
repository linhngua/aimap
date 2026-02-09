function parseIntEnv(env, key) {
  if (!env) return null;
  const raw = env[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

export function envInt(env, key, fallback, { min = null, max = null } = {}) {
  const value = parseIntEnv(env, key);
  const clamped =
    value === null
      ? fallback
      : min !== null && value < min
        ? min
        : max !== null && value > max
          ? max
          : value;
  return clamped;
}

const ONE_HOUR = 60 * 60;
const ONE_DAY = 24 * ONE_HOUR;

export function nearbyCacheTtlSeconds(env) {
  return envInt(env, "NEARBY_CACHE_TTL_SECONDS", 365 * ONE_DAY, { min: ONE_HOUR, max: 5 * 365 * ONE_DAY });
}

export function nearbyStaleAfterSeconds(env) {
  return envInt(env, "NEARBY_STALE_AFTER_SECONDS", 30 * ONE_DAY, { min: 60, max: 365 * ONE_DAY });
}

export function candidatesCacheTtlSeconds(env) {
  return envInt(env, "CANDIDATES_CACHE_TTL_SECONDS", 365 * ONE_DAY, { min: ONE_HOUR, max: 5 * 365 * ONE_DAY });
}

export function placeDetailCacheTtlSeconds(env) {
  return envInt(env, "PLACE_DETAIL_CACHE_TTL_SECONDS", 365 * ONE_DAY, { min: ONE_DAY, max: 5 * 365 * ONE_DAY });
}

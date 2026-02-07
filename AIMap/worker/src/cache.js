import { roundToCell, timeBucketSeconds } from "./utils.js";

const globalCache = new Map();

export function getCache(key, nowSeconds) {
  const entry = globalCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= nowSeconds) {
    globalCache.delete(key);
    return null;
  }
  return entry.value;
}

export function setCache(key, value, nowSeconds, ttlSeconds) {
  globalCache.set(key, { expiresAt: nowSeconds + ttlSeconds, value });
}

export function nearbyCacheKey(params) {
  const { lat, lng, radius_m, nowSeconds } = params;
  const roundedLat = roundToCell(lat, 3);
  const roundedLng = roundToCell(lng, 3);
  const bucket = timeBucketSeconds(nowSeconds, 30 * 60);
  return `nearby:${roundedLat},${roundedLng}:${radius_m}:${bucket}`;
}

export function placeCacheKey(placeLocalId) {
  return `place:${placeLocalId}`;
}

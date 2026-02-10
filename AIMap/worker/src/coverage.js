import { geohashEncode } from "./geohash.js";
import { kvGetJson, kvPutJson } from "./kv.js";
import { safeLog } from "./utils.js";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export const SUPPORTED_REGIONS = [
  {
    id: "singapore",
    title: "Singapore",
    center: { lat: 1.3521, lng: 103.8198 },
    bounds: { minLat: 1.13, maxLat: 1.48, minLng: 103.6, maxLng: 104.11 },
  },
  {
    id: "ho_chi_minh_city",
    title: "Ho Chi Minh City",
    center: { lat: 10.8231, lng: 106.6297 },
    bounds: { minLat: 10.35, maxLat: 11.2, minLng: 106.3, maxLng: 107.15 },
  },
];

function contains(bounds, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lat >= bounds.minLat && lat <= bounds.maxLat && lng >= bounds.minLng && lng <= bounds.maxLng;
}

export function coverageRegionFor(lat, lng) {
  return SUPPORTED_REGIONS.find((region) => contains(region.bounds, lat, lng)) ?? null;
}

export function isSupportedLatLng(lat, lng) {
  return coverageRegionFor(lat, lng) !== null;
}

export function outOfCoverageMessage() {
  const names = SUPPORTED_REGIONS.map((region) => region.title).join(" and ");
  return `AIMap will be available soon in your area. Currently supported: ${names}.`;
}

async function bumpCounter(env, key, sample) {
  const previous = (await kvGetJson(env, key)) ?? { count: 0 };
  const count = (Number.isFinite(previous.count) ? previous.count : 0) + 1;
  const next = {
    count,
    lastAt: new Date().toISOString(),
    sample: sample ?? previous.sample ?? null,
  };
  await kvPutJson(env, key, next, ONE_YEAR_SECONDS);
  return next;
}

export async function recordOutOfCoverageRequest(env, { lat, lng, source = "unknown" } = {}) {
  if (!env?.MAP_CACHE) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const coarse = geohashEncode(lat, lng, 4);
  const sample = { lat, lng, source };

  await bumpCounter(env, "coverage:ooc:global", sample);
  await bumpCounter(env, `coverage:ooc:cell:${coarse}`, sample);
  await bumpCounter(env, `coverage:ooc:source:${source}`, sample);

  safeLog(env, "[coverage] out-of-coverage", { lat, lng, coarse, source });
}

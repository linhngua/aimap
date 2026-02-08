import { callNearbyLLM } from "./openai.js";
import { NEARBY_SYSTEM_PROMPT } from "./prompts.js";
import { errorResponse, getBypassCache, jsonResponse, safeLog } from "./utils.js";
import { PlaceCandidateSchema } from "./schema.js";
import { kvGetJson, kvPutJson } from "./kv.js";
import { geohashCenter, geohashNeighbors, haversineDistanceM } from "./geohash.js";
import { sha256Hex, stableStringify } from "./etag.js";
import { parseJsonLoose, sanitizeNearbyResponse } from "./sanitize.js";

const CATEGORY_KEYS = ["restaurants", "bars", "attractions", "shops"];

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const STALE_AFTER_SECONDS = 10 * 60;
const REFRESH_LOCK_SECONDS = 30;
const MAX_LLM_CANDIDATES = 40;
const MAX_ITEMS_PER_CATEGORY = 12;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function categoriesKey(categories) {
  if (!Array.isArray(categories)) return "rbas";
  const normalized = categories.filter((c) => typeof c === "string").map((c) => c.toLowerCase());
  const unique = Array.from(new Set(normalized)).sort();
  return unique.map((c) => c[0]).join("") || "rbas";
}

function radiusBucket(radius_m) {
  if (!Number.isFinite(radius_m)) return 800;
  if (radius_m <= 400) return 300;
  if (radius_m <= 1100) return 800;
  return 1500;
}

function nearbyKey({ cell_id, radius_bucket, categories_key, time_bucket }) {
  return `nearby:${cell_id}:${radius_bucket}:${categories_key}:${time_bucket}`;
}

function clampItems(payload) {
  if (!isObject(payload?.categories)) return payload;
  const categories = {};
  for (const key of CATEGORY_KEYS) {
    const items = Array.isArray(payload.categories[key]) ? payload.categories[key] : [];
    categories[key] = items.slice(0, MAX_ITEMS_PER_CATEGORY);
  }
  return { ...payload, categories };
}

async function computeEtag(payload) {
  const stable = stableStringify(payload);
  return await sha256Hex(stable);
}

function parseNearbyCachedRequest(input) {
  if (!isObject(input)) throw new Error("Invalid request");
  const lat = input.lat;
  const lng = input.lng;
  const radius_m = input.radius_m;
  if (typeof lat !== "number" || typeof lng !== "number") throw new Error("Invalid lat/lng");
  if (typeof radius_m !== "number" || !Number.isInteger(radius_m) || radius_m <= 0) throw new Error("Invalid radius_m");
  if (typeof input.cell_id !== "string" || input.cell_id.length < 4) throw new Error("Invalid cell_id");
  if (typeof input.time_bucket !== "string" || input.time_bucket.length < 1) throw new Error("Invalid time_bucket");
  const categories = Array.isArray(input.categories) ? input.categories : CATEGORY_KEYS;
  const client_etag = typeof input.client_etag === "string" ? input.client_etag : null;
  return {
    lat,
    lng,
    radius_m,
    radius_bucket: radiusBucket(radius_m),
    categories,
    categories_key: categoriesKey(categories),
    cell_id: input.cell_id,
    time_bucket: input.time_bucket,
    client_etag,
  };
}

function parseNearbyRefreshRequest(input) {
  const base = parseNearbyCachedRequest(input);
  const candidatesValue = Array.isArray(input.candidates) ? input.candidates : [];
  if (candidatesValue.length === 0) throw new Error("Missing candidates");
  if (candidatesValue.length > MAX_LLM_CANDIDATES) throw new Error("Too many candidates");
  const candidates = candidatesValue.map((c) => PlaceCandidateSchema.parse(c));
  return { ...base, candidates };
}

function cacheResponseEnvelope({ hit, stale, accuracy, source_cell_id, source_distance_m, etag, payload }) {
  return {
    hit,
    stale,
    accuracy,
    source_cell_id: source_cell_id ?? null,
    source_distance_m: source_distance_m ?? null,
    etag: etag ?? null,
    payload: payload ?? null,
  };
}

function bestCandidateEntry(query, entries) {
  let best = null;
  for (const entry of entries) {
    if (!entry) continue;
    const center = geohashCenter(entry.cell_id);
    if (!center) continue;
    const dist = haversineDistanceM({ lat: query.lat, lng: query.lng }, center);
    if (!best || dist < best.distance_m) {
      best = { ...entry, distance_m: dist };
    }
  }
  return best;
}

async function getCacheEntry(env, key, cell_id) {
  const cached = await kvGetJson(env, key);
  if (!cached || !isObject(cached) || !isObject(cached.payload) || typeof cached.etag !== "string") return null;
  return {
    key,
    cell_id,
    etag: cached.etag,
    produced_at: typeof cached.produced_at === "number" ? cached.produced_at : 0,
    payload: cached.payload,
  };
}

export async function handleNearbyCached(request, env) {
  let payloadUnknown;
  try {
    payloadUnknown = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  let payload;
  try {
    payload = parseNearbyCachedRequest(payloadUnknown);
  } catch (err) {
    return errorResponse("Invalid request", 400, String(err));
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const bypassCache = getBypassCache(request);
  const key = nearbyKey(payload);

  safeLog(env, "[nearby_cached] request", {
    cell_id: payload.cell_id,
    radius_bucket: payload.radius_bucket,
    time_bucket: payload.time_bucket,
    bypass_cache: bypassCache,
  });

  if (!bypassCache) {
    const exact = await getCacheEntry(env, key, payload.cell_id);
    if (exact) {
      const stale = exact.produced_at > 0 ? nowSeconds - exact.produced_at > STALE_AFTER_SECONDS : false;
      return jsonResponse(
        cacheResponseEnvelope({
          hit: true,
          stale,
          accuracy: "exact",
          etag: exact.etag,
          payload: exact.payload,
        }),
      );
    }

    const neighbors = geohashNeighbors(payload.cell_id);
    const neighborEntries = await Promise.all(
      neighbors.map(async (cell_id) => {
        const neighborKey = nearbyKey({ ...payload, cell_id });
        return await getCacheEntry(env, neighborKey, cell_id);
      }),
    );

    const bestNeighbor = bestCandidateEntry(payload, neighborEntries);
    if (bestNeighbor) {
      const stale =
        bestNeighbor.produced_at > 0 ? nowSeconds - bestNeighbor.produced_at > STALE_AFTER_SECONDS : false;
      return jsonResponse(
        cacheResponseEnvelope({
          hit: true,
          stale,
          accuracy: "approx",
          source_cell_id: bestNeighbor.cell_id,
          source_distance_m: Math.round(bestNeighbor.distance_m),
          etag: bestNeighbor.etag,
          payload: bestNeighbor.payload,
        }),
      );
    }

    const lowerCell = payload.cell_id.length > 1 ? payload.cell_id.slice(0, -1) : "";
    if (lowerCell) {
      const lowerKey = nearbyKey({ ...payload, cell_id: lowerCell });
      const lower = await getCacheEntry(env, lowerKey, lowerCell);
      if (lower) {
        const center = geohashCenter(lowerCell);
        const dist = center ? haversineDistanceM({ lat: payload.lat, lng: payload.lng }, center) : null;
        const stale = lower.produced_at > 0 ? nowSeconds - lower.produced_at > STALE_AFTER_SECONDS : false;
        return jsonResponse(
          cacheResponseEnvelope({
            hit: true,
            stale,
            accuracy: "approx",
            source_cell_id: lowerCell,
            source_distance_m: dist ? Math.round(dist) : null,
            etag: lower.etag,
            payload: lower.payload,
          }),
        );
      }
    }
  }

  return jsonResponse(
    cacheResponseEnvelope({
      hit: false,
      stale: false,
      accuracy: "miss",
      etag: null,
      payload: null,
    }),
  );
}

async function tryAcquireRefreshLock(env, key) {
  const lockKey = `lock:${key}`;
  const existing = await kvGetJson(env, lockKey);
  if (existing) return false;
  await kvPutJson(env, lockKey, { created_at: Date.now() }, REFRESH_LOCK_SECONDS);
  return true;
}

export async function handleNearbyRefresh(request, env) {
  let payloadUnknown;
  try {
    payloadUnknown = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  let payload;
  try {
    payload = parseNearbyRefreshRequest(payloadUnknown);
  } catch (err) {
    return errorResponse("Invalid request", 400, String(err));
  }

  const bypassCache = getBypassCache(request);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const key = nearbyKey(payload);

  safeLog(env, "[nearby_refresh] request", {
    cell_id: payload.cell_id,
    radius_bucket: payload.radius_bucket,
    time_bucket: payload.time_bucket,
    bypass_cache: bypassCache,
    candidates: payload.candidates.length,
  });

  const existing = await kvGetJson(env, key);
  if (!bypassCache && existing && typeof existing.etag === "string" && existing.etag === payload.client_etag) {
    return jsonResponse({ status: "unchanged", etag: existing.etag });
  }

  const gotLock = await tryAcquireRefreshLock(env, key);
  if (!gotLock && !bypassCache && existing && typeof existing.etag === "string" && isObject(existing.payload)) {
    return jsonResponse({ status: "unchanged", etag: existing.etag });
  }

  let llmText;
  try {
    llmText = await callNearbyLLM({
      env,
      systemPrompt: NEARBY_SYSTEM_PROMPT,
      payload: {
        lat: payload.lat,
        lng: payload.lng,
        radius_m: payload.radius_m,
        candidates: payload.candidates,
        user_context: undefined,
      },
      timeoutMs: 20_000,
      retries: 1,
    });
  } catch (err) {
    return errorResponse("LLM request failed", 502, String(err));
  }

  const responseUnknown = parseJsonLoose(llmText);
  const { response, meta } = sanitizeNearbyResponse(responseUnknown, {
    lat: payload.lat,
    lng: payload.lng,
    radius_m: payload.radius_m,
    candidates: payload.candidates,
  });

  safeLog(env, "[nearby_refresh] sanitize", meta);

  const grouped = clampItems(response);
  const resultPayload = {
    query: grouped.query,
    candidates: payload.candidates,
    categories: grouped.categories,
  };

  const etag = await computeEtag(resultPayload);
  if (!bypassCache && payload.client_etag && payload.client_etag === etag) {
    return jsonResponse({ status: "unchanged", etag });
  }

  const cacheValue = {
    etag,
    produced_at: nowSeconds,
    payload: resultPayload,
  };

  await kvPutJson(env, key, cacheValue, CACHE_TTL_SECONDS);

  const lowerCell = payload.cell_id.length > 1 ? payload.cell_id.slice(0, -1) : "";
  if (lowerCell) {
    const lowerKey = nearbyKey({ ...payload, cell_id: lowerCell });
    await kvPutJson(env, lowerKey, cacheValue, CACHE_TTL_SECONDS);
  }

  return jsonResponse({ status: "ok", etag, payload: resultPayload });
}


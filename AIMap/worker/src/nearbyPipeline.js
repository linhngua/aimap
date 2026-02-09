import { callNearbyLLM } from "./openai.js";
import { NEARBY_SYSTEM_PROMPT } from "./prompts.js";
import { errorResponse, getBypassCache, jsonResponse, safeLog } from "./utils.js";
import { PlaceCandidateSchema } from "./schema.js";
import { kvGetJson, kvPutJson } from "./kv.js";
import { geohashCenter, geohashNeighbors, haversineDistanceM } from "./geohash.js";
import { sha256Hex, stableStringify } from "./etag.js";
import { parseJsonLoose, sanitizeNearbyResponse } from "./sanitize.js";
import { findBestCandidates, ingestCandidates } from "./candidatesStore.js";
import { candidatesCacheTtlSeconds, nearbyCacheTtlSeconds, nearbyStaleAfterSeconds } from "./config.js";

const CATEGORY_KEYS = ["restaurants", "bars", "attractions", "shops"];

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

function nearbyLatestKey({ cell_id, radius_bucket, categories_key }) {
  return `nearby_latest:${cell_id}:${radius_bucket}:${categories_key}`;
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
  const candidatesValue = Array.isArray(input.candidates) ? input.candidates : null;
  if (candidatesValue && candidatesValue.length > MAX_LLM_CANDIDATES) throw new Error("Too many candidates");
  const candidates = candidatesValue ? candidatesValue.map((c) => PlaceCandidateSchema.parse(c)) : null;
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
    stored_accuracy: typeof cached.accuracy === "string" ? cached.accuracy : null,
    stored_source_cell_id: typeof cached.source_cell_id === "string" ? cached.source_cell_id : null,
    stored_source_distance_m: typeof cached.source_distance_m === "number" ? cached.source_distance_m : null,
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
  const staleAfterSeconds = nearbyStaleAfterSeconds(env);
  const bypassCache = getBypassCache(request);
  const latestKey = nearbyLatestKey(payload);
  const bucketedKey = nearbyKey(payload);

  safeLog(env, "[nearby_cached] request", {
    cell_id: payload.cell_id,
    radius_bucket: payload.radius_bucket,
    time_bucket: payload.time_bucket,
    bypass_cache: bypassCache,
  });

  if (!bypassCache) {
    const exactLatest = await getCacheEntry(env, latestKey, payload.cell_id);
    if (exactLatest) {
      const stale = exactLatest.produced_at > 0 ? nowSeconds - exactLatest.produced_at > staleAfterSeconds : false;
      const accuracy = exactLatest.stored_accuracy === "approx" ? "approx" : "exact";
      return jsonResponse(
        cacheResponseEnvelope({
          hit: true,
          stale,
          accuracy,
          source_cell_id: accuracy === "approx" ? exactLatest.stored_source_cell_id ?? payload.cell_id : null,
          source_distance_m: accuracy === "approx" ? exactLatest.stored_source_distance_m : null,
          etag: exactLatest.etag,
          payload: exactLatest.payload,
        }),
      );
    }

    // Back-compat: accept older bucketed keys if present.
    const exactBucketed = await getCacheEntry(env, bucketedKey, payload.cell_id);
    if (exactBucketed) {
      const stale =
        exactBucketed.produced_at > 0 ? nowSeconds - exactBucketed.produced_at > staleAfterSeconds : false;
      const accuracy = exactBucketed.stored_accuracy === "approx" ? "approx" : "exact";
      return jsonResponse(
        cacheResponseEnvelope({
          hit: true,
          stale,
          accuracy,
          source_cell_id: accuracy === "approx" ? exactBucketed.stored_source_cell_id ?? payload.cell_id : null,
          source_distance_m: accuracy === "approx" ? exactBucketed.stored_source_distance_m : null,
          etag: exactBucketed.etag,
          payload: exactBucketed.payload,
        }),
      );
    }

    const neighbors = geohashNeighbors(payload.cell_id);
    const neighborEntries = await Promise.all(
      neighbors.map(async (cell_id) => {
        const neighborKey = nearbyLatestKey({ ...payload, cell_id });
        return await getCacheEntry(env, neighborKey, cell_id);
      }),
    );

    const bestNeighbor = bestCandidateEntry(payload, neighborEntries);
    if (bestNeighbor) {
      const stale =
        bestNeighbor.produced_at > 0 ? nowSeconds - bestNeighbor.produced_at > staleAfterSeconds : false;
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
      const lowerKey = nearbyLatestKey({ ...payload, cell_id: lowerCell });
      const lower = await getCacheEntry(env, lowerKey, lowerCell);
      if (lower) {
        const center = geohashCenter(lowerCell);
        const dist = center ? haversineDistanceM({ lat: payload.lat, lng: payload.lng }, center) : null;
        const stale = lower.produced_at > 0 ? nowSeconds - lower.produced_at > staleAfterSeconds : false;
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
  const cacheTtlSeconds = nearbyCacheTtlSeconds(env);
  const candidatesTtlSeconds = candidatesCacheTtlSeconds(env);
  const key = nearbyLatestKey(payload);

  safeLog(env, "[nearby_refresh] request", {
    cell_id: payload.cell_id,
    radius_bucket: payload.radius_bucket,
    time_bucket: payload.time_bucket,
    bypass_cache: bypassCache,
    candidates: Array.isArray(payload.candidates) ? payload.candidates.length : 0,
  });

  const existing = await kvGetJson(env, key);
  if (!bypassCache && existing && typeof existing.etag === "string" && existing.etag === payload.client_etag) {
    return jsonResponse({ status: "unchanged", etag: existing.etag });
  }

  const gotLock = await tryAcquireRefreshLock(env, key);
  if (!gotLock && !bypassCache && existing && typeof existing.etag === "string" && isObject(existing.payload)) {
    return jsonResponse({ status: "unchanged", etag: existing.etag });
  }

  let candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const best = await findBestCandidates(
      env,
      { lat: payload.lat, lng: payload.lng },
      { cell_id: payload.cell_id, radius_bucket: payload.radius_bucket },
    );
    if (!best) {
      return errorResponse("Missing candidates for this area (ingest first).", 400);
    }
    candidates = best.candidates;
  }

  if (Array.isArray(payload.candidates) && payload.candidates.length > 0) {
    try {
      await ingestCandidates(env, {
        lat: payload.lat,
        lng: payload.lng,
        cell_id: payload.cell_id,
        radius_bucket: payload.radius_bucket,
        candidates: payload.candidates,
        nowSeconds,
        ttlSeconds: candidatesTtlSeconds,
      });
    } catch (err) {
      safeLog(env, "[nearby_refresh] candidates_ingest_failed", { err: String(err) });
    }
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
        candidates,
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
    candidates,
  });

  safeLog(env, "[nearby_refresh] sanitize", meta);

  const grouped = clampItems(response);
  const resultPayload = {
    query: grouped.query,
    candidates,
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
    accuracy: "exact",
  };

  await kvPutJson(env, key, cacheValue, cacheTtlSeconds);

  const lowerCell = payload.cell_id.length > 1 ? payload.cell_id.slice(0, -1) : "";
  if (lowerCell) {
    await kvPutJson(
      env,
      nearbyLatestKey({ ...payload, cell_id: lowerCell }),
      cacheValue,
      cacheTtlSeconds,
    );
  }

  return jsonResponse({ status: "ok", etag, payload: resultPayload });
}

import { errorResponse, jsonResponse, safeLog } from "./utils.js";
import { PlaceCandidateSchema } from "./schema.js";
import { geohashEncode } from "./geohash.js";
import { ingestCandidates } from "./candidatesStore.js";
import { candidatesCacheTtlSeconds } from "./config.js";
import { isSupportedLatLng, outOfCoverageMessage, recordOutOfCoverageRequest } from "./coverage.js";
import { processQueuedPrimeIfAny } from "./primeQueue.js";
import { upsertPoiWebsite } from "./poiImageDb.js";

const MAX_LLM_CANDIDATES = 40;
const FIXED_CATEGORIES_KEY = "abrs";
const POI_WEBSITE_CELL_PRECISION = 6;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function radiusBucket(radius_m) {
  if (!Number.isFinite(radius_m)) return 800;
  if (radius_m <= 400) return 300;
  if (radius_m <= 1100) return 800;
  return 1500;
}

function geohashPrecisionForRadiusBucket(bucket) {
  if (bucket === 300) return 7;
  if (bucket === 800) return 6;
  return 5;
}

async function seedPoiWebsitesFromCandidates(env, candidates) {
  const db = env?.IMAGE_CELL_DB ?? env?.DB;
  const hasDb = db && typeof db.prepare === "function";
  if (!hasDb) return;
  if (!Array.isArray(candidates) || candidates.length === 0) return;

  const byPoiId = new Map();
  for (const c of candidates) {
    const poi_id = typeof c?.place_local_id === "string" ? c.place_local_id : "";
    const website_url = typeof c?.url === "string" ? c.url.trim() : "";
    if (!poi_id || !website_url) continue;
    if (byPoiId.has(poi_id)) continue;
    const cell_id = geohashEncode(c.lat, c.lng, POI_WEBSITE_CELL_PRECISION);
    byPoiId.set(poi_id, { poi_id, website_url, cell_id });
  }

  for (const entry of byPoiId.values()) {
    try {
      await upsertPoiWebsite(env, entry);
    } catch {
      // Ignore D1 seed failures (optional feature).
    }
  }
}

export async function handleCandidatesIngest(request, env, ctx) {
  let payloadUnknown;
  try {
    payloadUnknown = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  if (!isObject(payloadUnknown)) return errorResponse("Invalid request", 400);

  const lat = payloadUnknown.lat;
  const lng = payloadUnknown.lng;
  const radius_m = payloadUnknown.radius_m;
  if (typeof lat !== "number" || typeof lng !== "number") return errorResponse("Invalid lat/lng", 400);
  if (!isSupportedLatLng(lat, lng)) {
    await recordOutOfCoverageRequest(env, { lat, lng, source: "candidates_ingest" });
    return errorResponse(outOfCoverageMessage(), 403, { code: "OUT_OF_COVERAGE" });
  }
  if (typeof radius_m !== "number" || !Number.isInteger(radius_m) || radius_m <= 0) return errorResponse("Invalid radius_m", 400);

  const candidatesValue = Array.isArray(payloadUnknown.candidates) ? payloadUnknown.candidates : [];
  if (candidatesValue.length === 0) return errorResponse("Missing candidates", 400);
  if (candidatesValue.length > MAX_LLM_CANDIDATES) return errorResponse("Too many candidates", 400);

  let candidates;
  try {
    candidates = candidatesValue.map((c) => PlaceCandidateSchema.parse(c));
  } catch (err) {
    return errorResponse("Invalid candidates", 400, String(err));
  }

  const bucket = radiusBucket(radius_m);
  const precision = geohashPrecisionForRadiusBucket(bucket);
  const cell_id =
    typeof payloadUnknown.cell_id === "string" && payloadUnknown.cell_id.length > 0
      ? payloadUnknown.cell_id
      : geohashEncode(lat, lng, precision);

  const nowSeconds = Math.floor(Date.now() / 1000);

  safeLog(env, "[candidates_ingest] request", {
    cell_id,
    radius_bucket: bucket,
    candidates: candidates.length,
  });

  try {
    const stored = await ingestCandidates(env, {
      lat,
      lng,
      cell_id,
      radius_bucket: bucket,
      candidates,
      nowSeconds,
      ttlSeconds: candidatesCacheTtlSeconds(env),
    });

    const seedPromise = seedPoiWebsitesFromCandidates(env, stored.candidates).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(seedPromise);
    } else {
      await seedPromise;
    }

    if (env.OPENAI_API_KEY) {
      const primePromise = processQueuedPrimeIfAny(env, {
        cell_id,
        radius_bucket: bucket,
        categories_key: FIXED_CATEGORIES_KEY,
        candidates: stored.candidates,
      }).catch((err) => safeLog(env, "[candidates_ingest] prime_queue_failed", { err: String(err) }));
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(primePromise);
      } else {
        await primePromise;
      }
    }

    return jsonResponse({ status: "ok", cell_id, radius_bucket: bucket, etag: stored.etag, stored_candidates: stored.candidates.length });
  } catch (err) {
    return errorResponse("Failed to ingest candidates", 500, String(err));
  }
}

import { callNearbyLLM, callPlaceLLM } from "./openai.js";
import { NEARBY_SYSTEM_PROMPT, PLACE_SYSTEM_PROMPT } from "./prompts.js";
import { NearbyRequestSchema, PlaceDetailRequestSchema } from "./schema.js";
import { getCache, nearbyCacheKey, setCache } from "./cache.js";
import { kvGetJson, kvPutJson } from "./kv.js";
import { errorResponse, getBypassCache, jsonResponse, safeLog } from "./utils.js";
import { parseJsonLoose, sanitizeNearbyResponse, sanitizePlaceDetailResponse } from "./sanitize.js";
import { placeDetailCacheTtlSeconds } from "./config.js";
import { isSupportedLatLng, outOfCoverageMessage, recordOutOfCoverageRequest } from "./coverage.js";

export async function handleNearby(request, env) {
  let payloadUnknown;
  try {
    payloadUnknown = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const parsed = NearbyRequestSchema.safeParse(payloadUnknown);
  if (!parsed.success) {
    return errorResponse("Invalid request", 400, String(parsed.error));
  }

  const payload = parsed.data;
  if (!isSupportedLatLng(payload.lat, payload.lng)) {
    await recordOutOfCoverageRequest(env, { lat: payload.lat, lng: payload.lng, source: "nearby" });
    return errorResponse(outOfCoverageMessage(), 403, { code: "OUT_OF_COVERAGE" });
  }
  const bypassCache = getBypassCache(request);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cacheKey = nearbyCacheKey({
    lat: payload.lat,
    lng: payload.lng,
    radius_m: payload.radius_m,
    nowSeconds,
  });

  safeLog(env, "[nearby] request", {
    lat: payload.lat,
    lng: payload.lng,
    radius_m: payload.radius_m,
    candidates: payload.candidates.length,
    bypass_cache: bypassCache,
    cache_key: cacheKey,
  });

  if (!bypassCache) {
    const cached = getCache(cacheKey, nowSeconds);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        const { response } = sanitizeNearbyResponse(data, payload);
        safeLog(env, "[nearby] cache_hit", { cache_key: cacheKey });
        return jsonResponse(response);
      } catch {
        // ignore cache parse errors
      }
    }
  }

  let llmText;
  try {
    llmText = await callNearbyLLM({
      env,
      systemPrompt: NEARBY_SYSTEM_PROMPT,
      payload,
      timeoutMs: 20_000,
      retries: 1,
    });
  } catch (err) {
    return errorResponse("LLM request failed", 502, String(err));
  }

  const responseUnknown = parseJsonLoose(llmText);
  const { response, meta } = sanitizeNearbyResponse(responseUnknown, payload);
  safeLog(env, "[nearby] sanitize", meta);

  safeLog(env, "[nearby] ok", {
    counts: {
      restaurants: response.categories.restaurants.length,
      bars: response.categories.bars.length,
      attractions: response.categories.attractions.length,
      shops: response.categories.shops.length,
    },
  });

  const serialized = JSON.stringify(response);
  setCache(cacheKey, serialized, nowSeconds, 30 * 60);
  return jsonResponse(response);
}

function placeDetailCacheKey(placeLocalId) {
  return `place_detail:${placeLocalId}`;
}

export async function handlePlaceDetail(request, env) {
  let payloadUnknown;
  try {
    payloadUnknown = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const parsed = PlaceDetailRequestSchema.safeParse(payloadUnknown);
  if (!parsed.success) {
    return errorResponse("Invalid request", 400, String(parsed.error));
  }

  const payload = parsed.data;
  const bypassCache = getBypassCache(request);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const key = placeDetailCacheKey(payload.place.place_local_id);

  safeLog(env, "[place] request", {
    place_local_id: payload.place.place_local_id,
    name: payload.place.name,
    bypass_cache: bypassCache,
    cache_key: key,
    review_snippets: payload.review_snippets.length,
    nearby_context_candidates: payload.nearby_context_candidates.length,
    area_facts: payload.area_context?.area_facts?.length ?? 0,
  });

  if (!bypassCache) {
    const cached = await kvGetJson(env, key);
    if (cached) {
      const { response } = sanitizePlaceDetailResponse(cached, payload);
      safeLog(env, "[place] cache_hit", { cache_key: key });
      return jsonResponse(response);
    }
  }

  let llmText;
  try {
    llmText = await callPlaceLLM({
      env,
      systemPrompt: PLACE_SYSTEM_PROMPT,
      payload,
      timeoutMs: 20_000,
      retries: 1,
    });
  } catch (err) {
    return errorResponse("LLM request failed", 502, String(err));
  }

  const responseUnknown = parseJsonLoose(llmText);
  const { response, meta } = sanitizePlaceDetailResponse(responseUnknown, payload);
  safeLog(env, "[place] sanitize", meta);

  safeLog(env, "[place] ok", { place_local_id: response.place_local_id, mode: response.mode });

  await kvPutJson(env, key, response, placeDetailCacheTtlSeconds(env));
  return jsonResponse(response);
}

async function fetchWikipediaGeoSearch({ lat, lng, radius_m, limit }) {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "geosearch");
  url.searchParams.set("gscoord", `${lat}|${lng}`);
  url.searchParams.set("gsradius", String(radius_m));
  url.searchParams.set("gslimit", String(limit));
  url.searchParams.set("format", "json");
  const res = await fetch(url.toString(), { headers: { "user-agent": "AIMap/1.0 (area_facts)" } });
  if (!res.ok) throw new Error(`Wikipedia geosearch HTTP ${res.status}`);
  return await res.json();
}

async function fetchWikipediaExtractsByPageIds(pageIds) {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("exintro", "1");
  url.searchParams.set("exsentences", "1");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("pageids", pageIds.join("|"));
  url.searchParams.set("format", "json");
  const res = await fetch(url.toString(), { headers: { "user-agent": "AIMap/1.0 (area_facts)" } });
  if (!res.ok) throw new Error(`Wikipedia extracts HTTP ${res.status}`);
  return await res.json();
}

function normalizeFactsFromWikipedia(geo, extracts) {
  const pages = extracts?.query?.pages ?? {};
  const geoItems = Array.isArray(geo?.query?.geosearch) ? geo.query.geosearch : [];

  const facts = [];
  for (const item of geoItems) {
    const pageid = String(item.pageid ?? "");
    if (!pageid || !pages[pageid]) continue;
    const title = pages[pageid]?.title ?? item.title ?? "";
    const extract = typeof pages[pageid]?.extract === "string" ? pages[pageid].extract.trim() : "";
    if (!title) continue;

    const text = extract.length > 0 ? extract : `Nearby: ${title}.`;
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (cleaned.length < 8) continue;

    facts.push({
      fact: cleaned.length > 180 ? cleaned.slice(0, 177).trimEnd() + "…" : cleaned,
      source: `Wikipedia: ${title}`,
    });
    if (facts.length >= 5) break;
  }
  return facts;
}

export async function handleAreaFacts(request, env) {
  let payloadUnknown;
  try {
    payloadUnknown = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const lat = payloadUnknown?.lat;
  const lng = payloadUnknown?.lng;
  const radius_m = payloadUnknown?.radius_m;
  const cell_id = payloadUnknown?.cell_id;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return errorResponse("Invalid request", 400, "Invalid lat/lng");
  }
  if (!isSupportedLatLng(lat, lng)) {
    await recordOutOfCoverageRequest(env, { lat, lng, source: "area_facts" });
    return errorResponse(outOfCoverageMessage(), 403, { code: "OUT_OF_COVERAGE" });
  }
  if (typeof radius_m !== "number" || !Number.isInteger(radius_m) || radius_m <= 0) {
    return errorResponse("Invalid request", 400, "Invalid radius_m");
  }
  if (typeof cell_id !== "string" || cell_id.length < 4) {
    return errorResponse("Invalid request", 400, "Invalid cell_id");
  }

  const bypassCache = getBypassCache(request);
  const key = `area_facts:${cell_id}`;

  safeLog(env, "[area_facts] request", { cell_id, radius_m, bypass_cache: bypassCache });

  if (!bypassCache) {
    const cached = await kvGetJson(env, key);
    if (cached && Array.isArray(cached.facts)) {
      safeLog(env, "[area_facts] cache_hit", { key });
      return jsonResponse({ facts: cached.facts });
    }
  }

  try {
    const radius = Math.max(200, Math.min(5000, radius_m));
    const geo = await fetchWikipediaGeoSearch({ lat, lng, radius_m: radius, limit: 6 });
    const ids = Array.isArray(geo?.query?.geosearch)
      ? geo.query.geosearch.map((x) => x.pageid).filter((x) => Number.isInteger(x))
      : [];
    const pageIds = ids.slice(0, 6);
    const extracts = pageIds.length > 0 ? await fetchWikipediaExtractsByPageIds(pageIds) : null;
    const facts = normalizeFactsFromWikipedia(geo, extracts);

    const response = { facts };
    await kvPutJson(env, key, response, 30 * 24 * 60 * 60);
    safeLog(env, "[area_facts] ok", { count: facts.length });
    return jsonResponse(response);
  } catch (err) {
    safeLog(env, "[area_facts] error", { err: String(err) });
    return jsonResponse({ facts: [] });
  }
}

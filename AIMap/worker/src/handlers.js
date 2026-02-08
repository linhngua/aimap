import { callNearbyLLM, callPlaceLLM } from "./openai.js";
import { NEARBY_SYSTEM_PROMPT, PLACE_SYSTEM_PROMPT } from "./prompts.js";
import { NearbyRequestSchema, PlaceDetailRequestSchema } from "./schema.js";
import { getCache, nearbyCacheKey, placeCacheKey, setCache } from "./cache.js";
import { errorResponse, getBypassCache, jsonResponse, safeLog } from "./utils.js";
import { parseJsonLoose, sanitizeNearbyResponse, sanitizePlaceDetailResponse } from "./sanitize.js";

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

export async function handlePlace(request, env) {
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
  const key = placeCacheKey(payload.place.place_local_id);

  safeLog(env, "[place] request", {
    place_local_id: payload.place.place_local_id,
    name: payload.place.name,
    bypass_cache: bypassCache,
    cache_key: key,
    review_snippets: payload.review_snippets.length,
    first_party_keys: Object.keys(payload.first_party_signals).length,
  });

  if (!bypassCache) {
    const cached = getCache(key, nowSeconds);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        const { response } = sanitizePlaceDetailResponse(data, payload);
        safeLog(env, "[place] cache_hit", { cache_key: key });
        return jsonResponse(response);
      } catch {
        // ignore cache parse errors
      }
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

  const serialized = JSON.stringify(response);
  setCache(key, serialized, nowSeconds, 7 * 24 * 60 * 60);
  return jsonResponse(response);
}

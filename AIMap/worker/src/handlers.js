import { callNearbyLLM, callPlaceLLM } from "./openai.js";
import { NEARBY_SYSTEM_PROMPT, PLACE_SYSTEM_PROMPT } from "./prompts.js";
import {
  NearbyRequestSchema,
  NearbyResponseSchema,
  PlaceDetailRequestSchema,
  PlaceDetailResponseSchema,
} from "./schema.js";
import { getCache, nearbyCacheKey, placeCacheKey, setCache } from "./cache.js";
import { errorResponse, getBypassCache, jsonResponse } from "./utils.js";

function validateNearbyReferences(response, candidates) {
  const candidateIds = new Set(candidates.map((c) => c.place_local_id));
  const violations = [];

  const allItems = [
    ...response.categories.restaurants,
    ...response.categories.bars,
    ...response.categories.attractions,
    ...response.categories.shops,
  ];

  for (const item of allItems) {
    if (!candidateIds.has(item.place_local_id)) {
      violations.push(item.place_local_id);
    }
  }
  return violations;
}

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

  if (!bypassCache) {
    const cached = getCache(cacheKey, nowSeconds);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        const validated = NearbyResponseSchema.parse(data);
        return jsonResponse(validated);
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
      timeoutMs: 12_000,
      retries: 1,
    });
  } catch (err) {
    return errorResponse("LLM request failed", 502, String(err));
  }

  let responseUnknown;
  try {
    responseUnknown = JSON.parse(llmText);
  } catch {
    return errorResponse("LLM returned non-JSON", 502, llmText.slice(0, 500));
  }

  let response;
  try {
    response = NearbyResponseSchema.parse(responseUnknown);
  } catch (err) {
    return errorResponse("LLM returned invalid schema", 502, String(err));
  }

  const unknownIds = validateNearbyReferences(response, payload.candidates);
  if (unknownIds.length > 0) {
    return errorResponse("LLM referenced unknown candidate ids", 502, { unknown_ids: unknownIds });
  }

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

  if (!bypassCache) {
    const cached = getCache(key, nowSeconds);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        const validated = PlaceDetailResponseSchema.parse(data);
        return jsonResponse(validated);
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
      timeoutMs: 12_000,
      retries: 1,
    });
  } catch (err) {
    return errorResponse("LLM request failed", 502, String(err));
  }

  let responseUnknown;
  try {
    responseUnknown = JSON.parse(llmText);
  } catch {
    return errorResponse("LLM returned non-JSON", 502, llmText.slice(0, 500));
  }

  let response;
  try {
    response = PlaceDetailResponseSchema.parse(responseUnknown);
  } catch (err) {
    return errorResponse("LLM returned invalid schema", 502, String(err));
  }

  if (response.place_local_id !== payload.place.place_local_id) {
    return errorResponse("place_local_id mismatch", 502);
  }

  if (payload.review_snippets.length === 0 && response.mode !== "inference") {
    return errorResponse("Mode must be inference when no snippets", 502);
  }

  const serialized = JSON.stringify(response);
  setCache(key, serialized, nowSeconds, 7 * 24 * 60 * 60);
  return jsonResponse(response);
}

import { callNearbyLLM, callPlaceLLM } from "./openai.js";
import { NEARBY_SYSTEM_PROMPT, PLACE_SYSTEM_PROMPT } from "./prompts.js";
import {
  NearbyRequestSchema,
  NearbyResponseSchema,
  PlaceDetailRequestSchema,
  PlaceDetailResponseSchema,
} from "./schema.js";
import { getCache, nearbyCacheKey, placeCacheKey, setCache } from "./cache.js";
import { errorResponse, getBypassCache, jsonResponse, safeLog } from "./utils.js";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNearbyItemKeys(item) {
  if (!isObject(item)) return item;
  const place_local_id =
    typeof item.place_local_id === "string"
      ? item.place_local_id
      : typeof item.placeLocalId === "string"
        ? item.placeLocalId
        : "";

  let score = item.score;
  if (typeof score === "string") {
    const parsed = Number.parseFloat(score);
    score = Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof score !== "number") score = 0;

  const why =
    typeof item.why === "string"
      ? item.why
      : typeof item.reason === "string"
        ? item.reason
        : typeof item.explanation === "string"
          ? item.explanation
          : "";

  const best_for =
    typeof item.best_for === "string"
      ? item.best_for
      : typeof item.bestFor === "string"
        ? item.bestFor
        : typeof item.bestfor === "string"
          ? item.bestfor
          : "";

  const tagsValue = item.tags ?? item.tag;
  const tags = Array.isArray(tagsValue)
    ? tagsValue.filter((t) => typeof t === "string")
    : typeof tagsValue === "string"
      ? [tagsValue]
      : [];

  const cautionsValue = item.cautions ?? item.caution;
  const cautions = Array.isArray(cautionsValue)
    ? cautionsValue.filter((t) => typeof t === "string")
    : typeof cautionsValue === "string"
      ? [cautionsValue]
      : [];

  return { place_local_id, score, why, tags, best_for, cautions };
}

function normalizeNearbyLLMOutput(input, request) {
  if (!isObject(input)) return input;

  const categoryKeys = ["restaurants", "bars", "attractions", "shops"];
  const hasCategoriesObject = isObject(input.categories);
  const hasTopLevelArray = categoryKeys.some((k) => Array.isArray(input[k]));
  if (!hasCategoriesObject && !hasTopLevelArray) return input;

  const sourceCategories = isObject(input.categories) ? input.categories : input;

  const categories = {};
  for (const key of categoryKeys) {
    const value = sourceCategories[key];
    categories[key] = Array.isArray(value) ? value.map(normalizeNearbyItemKeys) : [];
  }

  let query = input.query;
  if (!isObject(query)) {
    query = { lat: request.lat, lng: request.lng, radius_m: request.radius_m };
  } else {
    query = {
      lat: typeof query.lat === "number" ? query.lat : request.lat,
      lng: typeof query.lng === "number" ? query.lng : request.lng,
      radius_m: Number.isInteger(query.radius_m) ? query.radius_m : request.radius_m,
    };
  }

  return { query, categories };
}

function normalizePlaceDetailLLMOutput(input) {
  if (!isObject(input)) return input;
  const normalized = { ...input };
  if (normalized.place_local_id === undefined && normalized.placeLocalId !== undefined) {
    normalized.place_local_id = normalized.placeLocalId;
    delete normalized.placeLocalId;
  }
  if (typeof normalized.mode === "string") {
    const mode = normalized.mode.toLowerCase();
    if (mode === "firstparty" || mode === "first-party") normalized.mode = "first_party";
  }
  if (typeof normalized.highlights === "string") normalized.highlights = [normalized.highlights];
  if (typeof normalized.cautions === "string") normalized.cautions = [normalized.cautions];
  if (typeof normalized.tips === "string") normalized.tips = [normalized.tips];
  return normalized;
}

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

function collectPlaceDetailText(detail) {
  return [
    detail.summary,
    ...(Array.isArray(detail.highlights) ? detail.highlights : []),
    ...(Array.isArray(detail.cautions) ? detail.cautions : []),
    ...(Array.isArray(detail.tips) ? detail.tips : []),
    detail.disclosure,
  ].filter((t) => typeof t === "string" && t.length > 0);
}

function excerpt(text, index, length) {
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + length + 24);
  return text.slice(start, end);
}

function findDisallowedReviewLanguage(texts) {
  const patterns = [
    {
      id: "people_say",
      regex: /\b(people|customers|patrons|locals|visitors|guests)\s+(say|mention|note|report|rave|complain)\b/i,
    },
    { id: "reviews_say", regex: /\breviews?\s+(say|mention|note|report|often|frequently)\b/i },
    { id: "according_to_reviews", regex: /\baccording to (the )?reviews?\b/i },
    { id: "reviewers", regex: /\breviewers?\b/i },
  ];

  const violations = [];
  for (const text of texts) {
    const quoteIndex = text.search(/[“”"]/);
    if (quoteIndex !== -1) {
      violations.push({
        id: "quotes",
        excerpt: excerpt(text, quoteIndex, 1),
      });
      continue;
    }

    for (const pattern of patterns) {
      const match = text.match(pattern.regex);
      if (match && match.index !== undefined) {
        violations.push({
          id: pattern.id,
          excerpt: excerpt(text, match.index, match[0].length),
        });
        break;
      }
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
        const validated = NearbyResponseSchema.parse(data);
        safeLog(env, "[nearby] cache_hit", { cache_key: cacheKey });
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
      timeoutMs: 20_000,
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
    response = NearbyResponseSchema.parse(normalizeNearbyLLMOutput(responseUnknown, payload));
  } catch (err) {
    safeLog(env, "[nearby] schema_error", { error: String(err), llm_json: responseUnknown });
    return errorResponse("LLM returned invalid schema", 502, String(err));
  }

  const unknownIds = validateNearbyReferences(response, payload.candidates);
  if (unknownIds.length > 0) {
    safeLog(env, "[nearby] invalid_candidate_ids", { unknown_ids: unknownIds });
    return errorResponse("LLM referenced unknown candidate ids", 502, { unknown_ids: unknownIds });
  }

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
        const validated = PlaceDetailResponseSchema.parse(data);
        safeLog(env, "[place] cache_hit", { cache_key: key });
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
      timeoutMs: 20_000,
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
    response = PlaceDetailResponseSchema.parse(normalizePlaceDetailLLMOutput(responseUnknown));
  } catch (err) {
    return errorResponse("LLM returned invalid schema", 502, String(err));
  }

  if (response.place_local_id !== payload.place.place_local_id) {
    return errorResponse("place_local_id mismatch", 502);
  }

  const hasReviewSnippets = payload.review_snippets.length > 0;
  const hasFirstPartySignals = Object.keys(payload.first_party_signals).length > 0;
  const expectedMode = hasReviewSnippets ? "signals" : hasFirstPartySignals ? "first_party" : "inference";
  if (response.mode !== expectedMode) {
    return errorResponse("Invalid mode for provided signals", 502, { expected: expectedMode, got: response.mode });
  }

  if (!hasReviewSnippets) {
    const violations = findDisallowedReviewLanguage(collectPlaceDetailText(response));
    if (violations.length > 0) {
      return errorResponse("Disallowed review/quote language without review_snippets", 502, { violations });
    }
  }

  safeLog(env, "[place] ok", { place_local_id: response.place_local_id, mode: response.mode });

  const serialized = JSON.stringify(response);
  setCache(key, serialized, nowSeconds, 7 * 24 * 60 * 60);
  return jsonResponse(response);
}

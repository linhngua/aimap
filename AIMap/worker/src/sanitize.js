const CATEGORY_KEYS = ["restaurants", "bars", "attractions", "shops"];

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function coerceNumber(value, fallback = 0) {
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}

function coerceStringArray(value) {
  if (Array.isArray(value)) {
    return value.filter((t) => typeof t === "string").map((t) => t.trim()).filter((t) => t.length > 0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  return [];
}

function stripQuotes(text) {
  return typeof text === "string" ? text.replace(/[“”"]/g, "") : text;
}

function normalizeNearbyItem(item) {
  if (!isObject(item)) return null;

  const place_local_id =
    typeof item.place_local_id === "string"
      ? item.place_local_id
      : typeof item.placeLocalId === "string"
        ? item.placeLocalId
        : "";

  const score = coerceNumber(item.score, 0);

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
  const tags = coerceStringArray(tagsValue);

  const cautionsValue = item.cautions ?? item.caution;
  const cautions = coerceStringArray(cautionsValue);

  return {
    place_local_id,
    score,
    why: stripQuotes(why),
    tags: tags.map(stripQuotes),
    best_for: stripQuotes(best_for),
    cautions: cautions.map(stripQuotes),
  };
}

function unwrapLLMObject(raw) {
  if (!isObject(raw)) return null;
  const wrapperKeys = ["response", "result", "data", "output"];
  for (const key of wrapperKeys) {
    if (isObject(raw[key])) return raw[key];
  }
  return raw;
}

function prettifyRawCategory(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const withoutPrefix = raw.replace(/^MKPOICategory/i, "");
  const spaced = withoutPrefix.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.trim().toLowerCase();
}

function classifyCandidate(candidate) {
  const categories = Array.isArray(candidate.raw_categories) ? candidate.raw_categories : [];
  const haystack = categories.join(" ").toLowerCase();

  const isRestaurant = /\b(restaurant|cafe|bakery|food|deli|meal)\b/i.test(haystack);
  const isBar = /\b(bar|nightlife|pub|brewery|winery|cocktail)\b/i.test(haystack);
  const isShop = /\b(store|shop|shopping|market|mall|boutique)\b/i.test(haystack);

  if (isBar) return "bars";
  if (isRestaurant) return "restaurants";
  if (isShop) return "shops";
  return "attractions";
}

function fallbackScore(candidate) {
  let score = 0;

  if (typeof candidate.rating === "number" && candidate.rating > 0) {
    score += Math.min(1, candidate.rating / 5) * 0.7;
  }
  if (typeof candidate.rating_count === "number" && candidate.rating_count > 0) {
    const scaled = Math.min(1, Math.log10(candidate.rating_count + 1) / 3);
    score += scaled * 0.2;
  }
  if (candidate.open_now === true) score += 0.1;
  if (typeof candidate.url === "string" && candidate.url.length > 0) score += 0.05;
  if (typeof candidate.phone === "string" && candidate.phone.length > 0) score += 0.05;

  return Math.min(1, score);
}

function buildNearbyFallback(payload) {
  const categories = {
    restaurants: [],
    bars: [],
    attractions: [],
    shops: [],
  };

  for (const candidate of payload.candidates) {
    const key = classifyCandidate(candidate);
    const tags = (Array.isArray(candidate.raw_categories) ? candidate.raw_categories : [])
      .map(prettifyRawCategory)
      .filter((t) => t.length > 0)
      .slice(0, 3);

    categories[key].push({
      place_local_id: candidate.place_local_id,
      score: fallbackScore(candidate),
      why: "Fallback grouping from MapKit categories.",
      tags,
      best_for:
        key === "restaurants"
          ? "a bite"
          : key === "bars"
            ? "a drink"
            : key === "shops"
              ? "browsing"
              : "a quick visit",
      cautions: [],
    });
  }

  for (const key of CATEGORY_KEYS) {
    categories[key].sort((a, b) => b.score - a.score);
  }

  return {
    query: { lat: payload.lat, lng: payload.lng, radius_m: payload.radius_m },
    categories,
  };
}

export function sanitizeNearbyResponse(raw, payload) {
  const meta = {
    used_fallback: false,
    dropped_invalid_items: 0,
    dropped_unknown_candidate_ids: 0,
    dropped_duplicates: 0,
    source_format: "unknown",
  };

  const candidateIds = new Set(payload.candidates.map((c) => c.place_local_id));

  const root = unwrapLLMObject(raw);
  let source = null;
  if (isObject(root) && isObject(root.categories)) {
    source = root.categories;
    meta.source_format = "categories";
  } else if (isObject(root) && CATEGORY_KEYS.some((k) => Array.isArray(root[k]))) {
    source = root;
    meta.source_format = "top_level";
  }

  const categories = {
    restaurants: [],
    bars: [],
    attractions: [],
    shops: [],
  };

  const seen = new Set();

  for (const key of CATEGORY_KEYS) {
    const items = Array.isArray(source?.[key]) ? source[key] : [];
    for (const item of items) {
      const normalized = normalizeNearbyItem(item);
      if (!normalized) {
        meta.dropped_invalid_items += 1;
        continue;
      }
      if (typeof normalized.place_local_id !== "string" || normalized.place_local_id.length === 0) {
        meta.dropped_invalid_items += 1;
        continue;
      }
      if (!candidateIds.has(normalized.place_local_id)) {
        meta.dropped_unknown_candidate_ids += 1;
        continue;
      }
      if (seen.has(normalized.place_local_id)) {
        meta.dropped_duplicates += 1;
        continue;
      }
      seen.add(normalized.place_local_id);
      categories[key].push(normalized);
    }
    categories[key].sort((a, b) => b.score - a.score);
  }

  const response = {
    query: { lat: payload.lat, lng: payload.lng, radius_m: payload.radius_m },
    categories,
  };

  const hasAnyItems = CATEGORY_KEYS.some((k) => response.categories[k].length > 0);
  if (!hasAnyItems && payload.candidates.length > 0) {
    meta.used_fallback = true;
    return { response: buildNearbyFallback(payload), meta };
  }

  return { response, meta };
}

function excerpt(text, index, length) {
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + length + 24);
  return text.slice(start, end);
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

function expectedPlaceMode(payload) {
  const hasReviewSnippets = Array.isArray(payload.review_snippets) && payload.review_snippets.length > 0;
  const hasFirstPartySignals =
    payload.first_party_signals && Object.keys(payload.first_party_signals).length > 0;
  return hasReviewSnippets ? "signals" : hasFirstPartySignals ? "first_party" : "inference";
}

function priceLevelSymbols(priceLevel) {
  if (!Number.isInteger(priceLevel) || priceLevel <= 0) return "";
  return "$".repeat(Math.min(4, priceLevel));
}

function buildPlaceDisclosure(mode) {
  if (mode === "signals") {
    return "AI summary based only on the provided metadata and review snippets (no invented reviews).";
  }
  if (mode === "first_party") {
    return "AI summary based only on the provided metadata and first-party signals.";
  }
  return "AI inference based only on the provided place metadata. No review snippets were provided.";
}

function buildSafePlaceDetail(payload) {
  const place = payload.place;
  const mode = expectedPlaceMode(payload);

  const categories = (Array.isArray(place.raw_categories) ? place.raw_categories : [])
    .map(prettifyRawCategory)
    .filter((t) => t.length > 0);

  const highlights = [];
  if (categories.length > 0) highlights.push(`Category: ${categories.slice(0, 2).join(", ")}`);
  if (typeof place.address_short === "string" && place.address_short.length > 0) {
    highlights.push(`Near: ${place.address_short}`);
  }
  if (typeof place.rating === "number") {
    const count = typeof place.rating_count === "number" ? ` (${place.rating_count})` : "";
    highlights.push(`Rating: ${place.rating.toFixed(1)}${count}`);
  }
  const price = priceLevelSymbols(place.price_level);
  if (price) highlights.push(`Price: ${price}`);
  if (place.open_now === true) highlights.push("Open now");
  if (place.open_now === false) highlights.push("Currently closed");
  if (typeof place.url === "string" && place.url.length > 0) highlights.push("Website available");
  if (typeof place.phone === "string" && place.phone.length > 0) highlights.push("Phone available");

  const normalizedHighlights = highlights.slice(0, 3);
  while (normalizedHighlights.length < 3) {
    normalizedHighlights.push("Details based on MapKit metadata.");
  }

  const cautions =
    mode === "inference"
      ? ["No review snippets provided; summary is an AI inference.", "Verify hours and details on the official listing."]
      : ["Verify hours and details on the official listing."];

  const tips = [];
  if (typeof place.url === "string" && place.url.length > 0) tips.push("Open the website to confirm hours/menu/prices.");
  if (typeof place.phone === "string" && place.phone.length > 0) tips.push("Call ahead if hours or availability matter.");
  tips.push("Use directions to verify the entrance and parking.");

  const summaryParts = [place.name];
  if (typeof place.address_short === "string" && place.address_short.length > 0) {
    summaryParts.push(`near ${place.address_short}`);
  }
  const summary = stripQuotes(summaryParts.join(" "));

  return {
    place_local_id: place.place_local_id,
    mode,
    summary,
    highlights: normalizedHighlights.map(stripQuotes),
    cautions: cautions.map(stripQuotes).slice(0, 2),
    tips: tips.map(stripQuotes).slice(0, 3),
    disclosure: buildPlaceDisclosure(mode),
  };
}

export function sanitizePlaceDetailResponse(raw, payload) {
  const meta = {
    used_fallback: false,
    stripped_extra_fields: true,
    disallowed_review_language: [],
  };

  const expectedMode = expectedPlaceMode(payload);
  const root = unwrapLLMObject(raw) ?? {};

  const summary = coerceString(root.summary ?? root.overview ?? root.description, "").trim();
  const highlights = coerceStringArray(root.highlights ?? root.highlight ?? root.pros ?? root.bullets);
  const cautions = coerceStringArray(root.cautions ?? root.caution ?? root.cons ?? root.warnings);
  const tips = coerceStringArray(root.tips ?? root.tip ?? root.suggestions);
  const disclosure = coerceString(root.disclosure, "").trim();

  let response = {
    place_local_id: payload.place.place_local_id,
    mode: expectedMode,
    summary: stripQuotes(summary),
    highlights: highlights.map(stripQuotes),
    cautions: cautions.map(stripQuotes),
    tips: tips.map(stripQuotes),
    disclosure: stripQuotes(disclosure.length > 0 ? disclosure : buildPlaceDisclosure(expectedMode)),
  };

  if (response.summary.length === 0 || response.highlights.length === 0) {
    meta.used_fallback = true;
    response = buildSafePlaceDetail(payload);
    return { response, meta };
  }

  if (response.highlights.length < 1) response.highlights = buildSafePlaceDetail(payload).highlights;
  if (response.cautions.length < 1) response.cautions = buildSafePlaceDetail(payload).cautions;
  if (response.tips.length < 1) response.tips = buildSafePlaceDetail(payload).tips;
  if (response.disclosure.length === 0) response.disclosure = buildPlaceDisclosure(expectedMode);

  if (expectedMode === "inference") {
    const violations = findDisallowedReviewLanguage(collectPlaceDetailText(response));
    if (violations.length > 0) {
      meta.used_fallback = true;
      meta.disallowed_review_language = violations;
      response = buildSafePlaceDetail(payload);
    }
  }

  return { response, meta };
}

export function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenceMatch = trimmed.match(/```(?:json)?\\s*([\\s\\S]*?)\\s*```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // continue
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // continue
    }
  }

  return null;
}


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

function findDisallowedLanguage(texts) {
  const patterns = [
    {
      id: "people_say",
      regex: /\b(people|customers|patrons|locals|visitors|guests)\s+(say|mention|note|report|rave|complain)\b/i,
    },
    { id: "reviews_say", regex: /\breviews?\s+(say|mention|note|report|often|frequently)\b/i },
    { id: "according_to_reviews", regex: /\baccording to (the )?reviews?\b/i },
    { id: "reviewers", regex: /\breviewers?\b/i },
    { id: "quotes", regex: /[“”"]/ },
    {
      id: "menu_items",
      regex:
        /\b(signature|must[-\s]?try|try the|order the|dish|cocktail|menu|tasting|chef['’]s|wine list)\b/i,
    },
    {
      id: "overclaim",
      regex: /\b(best|famous|iconic|legendary|top[-\s]?rated|award[-\s]?winning|michelin|popular|beloved)\b/i,
    },
  ];

  const violations = [];
  for (const text of texts) {
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
  return hasReviewSnippets ? "signals" : "inference";
}

function buildPlaceDisclosure(mode) {
  if (mode === "signals") {
    return "Summary includes provided review snippets.";
  }
  return "AI inference based only on place metadata and nearby context.";
}

function normalizePrimaryCategory(value) {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  if (s.includes("bar")) return "bar";
  if (s.includes("rest") || s.includes("food") || s.includes("cafe")) return "restaurant";
  if (s.includes("shop") || s.includes("store") || s.includes("market")) return "shop";
  if (s.includes("attract") || s.includes("landmark") || s.includes("museum") || s.includes("park")) return "attraction";
  return s || "attraction";
}

function confidenceFromPayload(payload) {
  const place = payload.place ?? {};
  const hasRatingCount = Number.isInteger(place.rating_count) && place.rating_count > 0;
  const hasContact = place.url_exists === true || place.phone_exists === true;
  const hasCategories = Array.isArray(place.raw_categories) && place.raw_categories.length > 0;
  const hasHours = place.open_now === true || place.open_now === false || typeof place.hours_summary === "string";

  const score = [hasRatingCount, hasContact, hasCategories, hasHours].filter(Boolean).length;
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function areaFunFactsFromPayload(payload) {
  const facts = Array.isArray(payload?.area_context?.area_facts) ? payload.area_context.area_facts : [];
  const placeName = typeof payload?.place?.name === "string" ? payload.place.name.toLowerCase() : "";
  const out = [];
  for (const f of facts) {
    const fact = typeof f.fact === "string" ? f.fact.trim() : "";
    const source = typeof f.source === "string" ? f.source.trim() : "";
    if (!fact || !source) continue;
    if (placeName.length > 4 && fact.toLowerCase().includes(placeName)) {
      continue;
    }
    out.push({ fact: stripQuotes(fact), source: stripQuotes(source) });
    if (out.length >= 2) break;
  }
  return out;
}

function buildNearbyMoves(payload) {
  const placeId = payload?.place?.place_local_id;
  const primary = normalizePrimaryCategory(payload?.place?.primary_category);
  const candidates = Array.isArray(payload?.nearby_context_candidates) ? payload.nearby_context_candidates : [];
  const filtered = candidates
    .filter((c) => isObject(c) && typeof c.place_local_id === "string" && c.place_local_id !== placeId)
    .map((c) => ({
      place_local_id: c.place_local_id,
      name: coerceString(c.name, c.place_local_id),
      primary_category: normalizePrimaryCategory(c.primary_category),
      distance_m: Number.isInteger(c.distance_m) ? c.distance_m : Math.round(coerceNumber(c.distance_m, 0)),
    }))
    .filter((c) => c.distance_m >= 0)
    .sort((a, b) => a.distance_m - b.distance_m);

  const desiredByType = {
    restaurant: ["attraction", "bar", "shop"],
    bar: ["restaurant", "bar", "attraction"],
    attraction: ["restaurant", "bar", "shop"],
    shop: ["attraction", "restaurant", "bar"],
  };
  const desired = desiredByType[primary] ?? desiredByType.attraction;

  const chosen = [];
  const used = new Set();

  for (const wanted of desired) {
    const pick = filtered.find((c) => c.primary_category === wanted && !used.has(c.place_local_id));
    if (pick) {
      used.add(pick.place_local_id);
      chosen.push(pick);
    }
  }

  for (const c of filtered) {
    if (chosen.length >= 3) break;
    if (used.has(c.place_local_id)) continue;
    used.add(c.place_local_id);
    chosen.push(c);
  }

  return chosen.slice(0, 3).map((c) => ({
    place_local_id: c.place_local_id,
    label: c.name,
    reason: `Nearby ${c.primary_category} option (${c.distance_m} m).`,
  }));
}

function buildPractical(payload) {
  const place = payload.place;
  const mode = expectedPlaceMode(payload);

  const practical = [];
  if (place.url_exists === true) practical.push("Check the website for current hours/menu/details.");
  if (place.phone_exists === true) practical.push("Call ahead if hours or availability matter.");

  if (place.open_now === null && place.hours_summary === null) {
    practical.push("Hours aren’t provided here; verify before you go.");
  } else if (place.open_now === false) {
    practical.push("Marked closed right now; verify hours before heading over.");
  }

  const ratingCount = Number.isInteger(place.rating_count) ? place.rating_count : 0;
  if (mode === "inference" && ratingCount >= 500) {
    practical.push("Likely busier at peak times (inference).");
  }

  return practical.map(stripQuotes).slice(0, 3);
}

export function sanitizePlaceDetailResponse(raw, payload) {
  const meta = {
    used_fallback: false,
    stripped_extra_fields: true,
    disallowed_review_language: [],
  };

  const expectedMode = expectedPlaceMode(payload);
  const root = unwrapLLMObject(raw) ?? {};

  const headline = coerceString(root.headline ?? root.title ?? root.headline_text, "").trim();
  const whyWorthIt = coerceString(root.why_worth_it ?? root.whyWorthIt ?? root.why, "").trim();

  const disclosure = buildPlaceDisclosure(expectedMode);
  const confidence = confidenceFromPayload(payload);
  const nearby_moves = buildNearbyMoves(payload);
  const practical = buildPractical(payload);
  const area_fun_fact = areaFunFactsFromPayload(payload);

  let safeHeadline =
    headline.length > 0 && headline.length <= 80 ? stripQuotes(headline) : stripQuotes(payload.place.name);

  let safeWhy = stripQuotes(whyWorthIt);
  if (safeWhy.length === 0) {
    meta.used_fallback = true;
  }

  const textsToCheck = [safeHeadline, safeWhy].filter((t) => typeof t === "string" && t.length > 0);
  if (expectedMode === "inference") {
    const violations = findDisallowedLanguage(textsToCheck);
    if (violations.length > 0) {
      meta.used_fallback = true;
      meta.disallowed_review_language = violations;
      safeHeadline = stripQuotes(payload.place.name);
      safeWhy = "";
    }
  }

  if (safeWhy.length === 0) {
    const primary = normalizePrimaryCategory(payload.place.primary_category);
    const areaParts = [
      payload.area_context?.neighborhood_name,
      payload.area_context?.city,
      payload.area_context?.country,
    ].filter((x) => typeof x === "string" && x.length > 0);
    const area = areaParts.length > 0 ? areaParts[0] : payload.place.address_short || "this area";

    const line1 =
      primary === "restaurant"
        ? `A food stop near ${area}.`
        : primary === "bar"
          ? `A drink stop near ${area}.`
          : primary === "shop"
            ? `A shop to browse near ${area}.`
            : `A nearby point of interest near ${area}.`;
    const line2 = payload.place.url_exists
      ? "Website available for current hours/details."
      : payload.place.phone_exists
        ? "Phone available if you need to confirm details."
        : "Details are limited to basic listing metadata.";
    const next = nearby_moves.map((m) => m.label).slice(0, 2).join(" · ");
    const line3 = next ? `Next: ${next}.` : "";

    safeWhy = [line1, line2, line3].filter((l) => l.length > 0).join("\n");
  }

  // Ensure 2–3 short lines.
  const lines = safeWhy
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 3);
  while (lines.length < 2) lines.push("Check the listing for up-to-date details.");

  const response = {
    place_local_id: payload.place.place_local_id,
    mode: expectedMode,
    headline: safeHeadline,
    why_worth_it: lines.join("\n"),
    nearby_moves,
    practical,
    area_fun_fact,
    confidence,
    disclosure,
  };

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

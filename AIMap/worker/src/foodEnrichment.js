import { safeLog } from "./utils.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function radians(deg) {
  return (deg * Math.PI) / 180;
}

function haversineDistanceM(a, b) {
  const R = 6371000;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);

  const sin1 = Math.sin(dLat / 2);
  const sin2 = Math.sin(dLng / 2);
  const h = sin1 * sin1 + Math.cos(lat1) * Math.cos(lat2) * sin2 * sin2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function fetchWithTimeout(url, { timeoutMs, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? 8000);
  try {
    return await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithRetry(url, { timeoutMs = 8000, retries = 1, headers } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs, headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
    }
  }
  throw lastError ?? new Error("fetch failed");
}

function normalizeCuisineToken(cuisine) {
  if (typeof cuisine !== "string") return "";
  const cleaned = cuisine
    .split(/[;,/|]/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)[0];
  if (!cleaned) return "";
  // Keep single token-ish; TheMealDB uses "Vietnamese", "Italian", etc.
  const first = cleaned.split(/\s+/g)[0] ?? "";
  return first.trim().toLowerCase();
}

function titleCase(word) {
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function computeViewbox({ lat, lng, radius_m }) {
  const latDelta = clamp(radius_m / 111000, 0.001, 0.08);
  const lonDelta = clamp(radius_m / (111000 * Math.cos(radians(lat)) || 1), 0.001, 0.08);
  const minLat = lat - latDelta;
  const maxLat = lat + latDelta;
  const minLon = lng - lonDelta;
  const maxLon = lng + lonDelta;
  // Nominatim expects: left, top, right, bottom => (minLon, maxLat, maxLon, minLat)
  return `${minLon},${maxLat},${maxLon},${minLat}`;
}

export async function fetchOsmFoodSignals(env, { name, lat, lng, radius_m }) {
  const headers = { "user-agent": "AIMap/1.0 (poi-food-enrichment)" };
  const viewbox = computeViewbox({ lat, lng, radius_m: Math.max(250, Math.min(2000, radius_m)) });
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", name);
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("namedetails", "0");
  url.searchParams.set("bounded", "1");
  url.searchParams.set("viewbox", viewbox);

  try {
    const results = await fetchJsonWithRetry(url.toString(), { timeoutMs: 8000, retries: 1, headers });
    const list = Array.isArray(results) ? results : [];
    const origin = { lat, lng };

    let best = null;
    let bestDist = Infinity;
    for (const r of list) {
      const rLat = Number.parseFloat(r?.lat ?? "");
      const rLng = Number.parseFloat(r?.lon ?? "");
      if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) continue;
      const dist = haversineDistanceM(origin, { lat: rLat, lng: rLng });
      if (dist < bestDist) {
        bestDist = dist;
        best = r;
      }
    }

    const extratags = best?.extratags ?? {};
    const cuisine = typeof extratags?.cuisine === "string" ? extratags.cuisine.trim() : "";
    const menu_url = typeof extratags?.menu === "string" ? extratags.menu.trim() : "";

    const out = {
      cuisine_from_osm: cuisine.length > 0 ? cuisine.slice(0, 80) : null,
      menu_url_from_osm: menu_url.length > 0 ? menu_url.slice(0, 240) : null,
    };

    if (out.cuisine_from_osm || out.menu_url_from_osm) {
      safeLog(env, "[food] osm ok", { cuisine: out.cuisine_from_osm, has_menu: !!out.menu_url_from_osm });
    }
    return out;
  } catch (err) {
    safeLog(env, "[food] osm error", { err: String(err) });
    return { cuisine_from_osm: null, menu_url_from_osm: null };
  }
}

export async function fetchMealDbDishCandidates(env, cuisine) {
  const token = normalizeCuisineToken(cuisine);
  if (!token) return [];

  const area = titleCase(token);
  const url = new URL("https://www.themealdb.com/api/json/v1/1/filter.php");
  url.searchParams.set("a", area);

  try {
    const data = await fetchJsonWithRetry(url.toString(), {
      timeoutMs: 6000,
      retries: 1,
      headers: { "user-agent": "AIMap/1.0 (poi-food-enrichment)" },
    });
    const meals = Array.isArray(data?.meals) ? data.meals : [];
    const names = meals
      .map((m) => (typeof m?.strMeal === "string" ? m.strMeal.trim() : ""))
      .filter((n) => n.length >= 2 && n.length <= 60);
    const out = Array.from(new Set(names)).slice(0, 8);
    if (out.length > 0) {
      safeLog(env, "[food] mealdb ok", { area, count: out.length });
    }
    return out;
  } catch (err) {
    safeLog(env, "[food] mealdb error", { area, err: String(err) });
    return [];
  }
}


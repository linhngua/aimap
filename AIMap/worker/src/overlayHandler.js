import { geohashEncode } from "./geohash.js";
import { kvGetJson, kvList } from "./kv.js";
import { errorResponse, jsonResponse } from "./utils.js";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNearbyLatestKey(name) {
  const parts = typeof name === "string" ? name.split(":") : [];
  // nearby_latest:<cell_id>:<radius_bucket>:<categories_key>
  if (parts.length !== 4) return null;
  if (parts[0] !== "nearby_latest") return null;
  const cell_id = parts[1] ?? "";
  const radius_bucket = Number.parseInt(parts[2] ?? "", 10);
  const categories_key = parts[3] ?? "";
  if (!cell_id) return null;
  if (!Number.isInteger(radius_bucket)) return null;
  if (!categories_key) return null;
  return { cell_id, radius_bucket, categories_key };
}

function requireDb(env) {
  const db = env?.DB;
  if (!db || typeof db.prepare !== "function") return null;
  return db;
}

export async function handleOverlay(request, env) {
  let bodyUnknown;
  try {
    bodyUnknown = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  if (!isObject(bodyUnknown)) return errorResponse("Invalid request", 400);

  const lat = bodyUnknown.lat;
  const lng = bodyUnknown.lng;
  const radius_m = bodyUnknown.radius_m;
  if (typeof lat !== "number" || typeof lng !== "number") return errorResponse("Invalid lat/lng", 400);
  if (typeof radius_m !== "number" || !Number.isInteger(radius_m) || radius_m <= 0) {
    return errorResponse("Invalid radius_m", 400);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoffSeconds = nowSeconds - 7 * 24 * 60 * 60;
  const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const cell_prefix = geohashEncode(lat, lng, 4);

  // Nearby cache cells (KV)
  const cachedCellIds = new Set();
  if (env?.MAP_CACHE) {
    const listed = await kvList(env, { prefix: `nearby_latest:${cell_prefix}`, limit: 500 });
    const keys = Array.isArray(listed?.keys) ? listed.keys : [];
    for (const k of keys) {
      const parsed = parseNearbyLatestKey(k?.name);
      if (!parsed) continue;
      const cached = await kvGetJson(env, k.name);
      const produced_at = typeof cached?.produced_at === "number" ? cached.produced_at : 0;
      if (produced_at >= cutoffSeconds) {
        cachedCellIds.add(parsed.cell_id);
      }
    }
  }

  // POI image crawl cells (D1)
  const imageCellIds = new Set();
  const db = requireDb(env);
  if (db) {
    try {
      const like = `${cell_prefix}%`;
      const res = await db
        .prepare(
          `SELECT DISTINCT w.cell_id AS cell_id
           FROM poi_image_candidates c
           JOIN poi_websites w ON w.poi_id = c.poi_id
           WHERE w.cell_id LIKE ?
             AND c.last_seen_at >= ?
           LIMIT 800`,
        )
        .bind(like, cutoffMs)
        .all();
      const rows = Array.isArray(res?.results) ? res.results : [];
      for (const row of rows) {
        const cellId = typeof row?.cell_id === "string" ? row.cell_id : "";
        if (cellId) imageCellIds.add(cellId);
      }
    } catch {
      // ignore if schema not migrated yet
    }
  }

  return jsonResponse({
    query: { lat, lng, radius_m },
    cell_prefix,
    cached_cells: Array.from(cachedCellIds),
    image_cells: Array.from(imageCellIds),
    window_days: 7,
  });
}


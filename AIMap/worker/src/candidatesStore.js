import { PlaceCandidateSchema } from "./schema.js";
import { kvGetJson, kvPutJson } from "./kv.js";
import { sha256Hex, stableStringify } from "./etag.js";
import { geohashCenter, geohashNeighbors, haversineDistanceM } from "./geohash.js";
import { safeLog } from "./utils.js";

const MAX_LLM_CANDIDATES = 40;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function candidatesLatestKey({ cell_id, radius_bucket }) {
  return `candidates_latest:${cell_id}:${radius_bucket}`;
}

async function computeEtag(candidates) {
  return await sha256Hex(stableStringify({ candidates }));
}

function parseCandidatesPayload(raw) {
  if (!isObject(raw)) return null;
  const produced_at = typeof raw.produced_at === "number" ? raw.produced_at : 0;
  const etag = typeof raw.etag === "string" ? raw.etag : null;
  const candidates = Array.isArray(raw.candidates) ? raw.candidates : null;
  if (!etag || !candidates) return null;
  return { produced_at, etag, candidates };
}

export async function putCandidatesLatest(env, { cell_id, radius_bucket, candidates, produced_at, ttlSeconds }) {
  const trimmed = Array.isArray(candidates) ? candidates.slice(0, MAX_LLM_CANDIDATES) : [];
  const parsed = trimmed
    .map((c) => {
      try {
        return PlaceCandidateSchema.parse(c);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (parsed.length === 0) throw new Error("No valid candidates");

  const etag = await computeEtag(parsed);
  const value = {
    produced_at,
    etag,
    candidates: parsed,
  };
  await kvPutJson(env, candidatesLatestKey({ cell_id, radius_bucket }), value, ttlSeconds);
  return { etag, candidates: parsed };
}

export async function getCandidatesLatest(env, { cell_id, radius_bucket }) {
  const raw = await kvGetJson(env, candidatesLatestKey({ cell_id, radius_bucket }));
  const parsed = parseCandidatesPayload(raw);
  if (!parsed) return null;
  const candidates = parsed.candidates
    .slice(0, MAX_LLM_CANDIDATES)
    .map((c) => {
      try {
        return PlaceCandidateSchema.parse(c);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (candidates.length === 0) return null;
  return { cell_id, radius_bucket, produced_at: parsed.produced_at, etag: parsed.etag, candidates };
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

export async function findBestCandidates(env, query, { cell_id, radius_bucket }) {
  const exact = await getCandidatesLatest(env, { cell_id, radius_bucket });
  if (exact) return { ...exact, accuracy: "exact", source_cell_id: null, source_distance_m: null };

  const neighbors = geohashNeighbors(cell_id);
  const neighborEntries = await Promise.all(
    neighbors.map(async (neighborCellId) => await getCandidatesLatest(env, { cell_id: neighborCellId, radius_bucket })),
  );

  const bestNeighbor = bestCandidateEntry(query, neighborEntries);
  if (bestNeighbor) {
    return {
      ...bestNeighbor,
      accuracy: "approx",
      source_cell_id: bestNeighbor.cell_id,
      source_distance_m: Math.round(bestNeighbor.distance_m),
    };
  }

  const lowerCell = cell_id.length > 1 ? cell_id.slice(0, -1) : "";
  if (lowerCell) {
    const lower = await getCandidatesLatest(env, { cell_id: lowerCell, radius_bucket });
    if (lower) {
      const center = geohashCenter(lowerCell);
      const dist = center ? haversineDistanceM({ lat: query.lat, lng: query.lng }, center) : null;
      return {
        ...lower,
        accuracy: "approx",
        source_cell_id: lowerCell,
        source_distance_m: dist ? Math.round(dist) : null,
      };
    }
  }

  return null;
}

export async function ingestCandidates(env, { lat, lng, cell_id, radius_bucket, candidates, nowSeconds, ttlSeconds }) {
  const stored = await putCandidatesLatest(env, {
    cell_id,
    radius_bucket,
    candidates,
    produced_at: nowSeconds,
    ttlSeconds,
  });
  safeLog(env, "[candidates_ingest] ok", {
    cell_id,
    radius_bucket,
    candidates: stored.candidates.length,
  });
  return stored;
}


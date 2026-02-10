import { callNearbyLLM } from "./openai.js";
import { NEARBY_SYSTEM_PROMPT } from "./prompts.js";
import { nearbyCacheTtlSeconds } from "./config.js";
import { sha256Hex, stableStringify } from "./etag.js";
import { kvGetJson, kvPutJson } from "./kv.js";
import { parseJsonLoose, sanitizeNearbyResponse } from "./sanitize.js";
import { safeLog } from "./utils.js";

const PRIME_QUEUE_TTL_SECONDS = 24 * 60 * 60;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function primeQueueKey({ cell_id, radius_bucket, categories_key }) {
  return `prime_queue:${cell_id}:${radius_bucket}:${categories_key}`;
}

function nearbyLatestKey({ cell_id, radius_bucket, categories_key }) {
  return `nearby_latest:${cell_id}:${radius_bucket}:${categories_key}`;
}

export async function queuePrime(env, { lat, lng, radius_m, cell_id, radius_bucket, categories, categories_key }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    status: "queued",
    requested_at: nowSeconds,
    lat,
    lng,
    radius_m,
    cell_id,
    radius_bucket,
    categories,
    categories_key,
  };
  await kvPutJson(env, primeQueueKey({ cell_id, radius_bucket, categories_key }), payload, PRIME_QUEUE_TTL_SECONDS);
  return payload;
}

export async function getPrimeJob(env, { cell_id, radius_bucket, categories_key }) {
  const job = await kvGetJson(env, primeQueueKey({ cell_id, radius_bucket, categories_key }));
  if (!job || !isObject(job)) return null;
  return job;
}

async function computeEtag(payload) {
  return await sha256Hex(stableStringify(payload));
}

async function storeNearbyLatest(env, { cell_id, radius_bucket, categories_key, cacheValue }) {
  await kvPutJson(env, nearbyLatestKey({ cell_id, radius_bucket, categories_key }), cacheValue, nearbyCacheTtlSeconds(env));

  const lowerCell = cell_id.length > 1 ? cell_id.slice(0, -1) : "";
  if (lowerCell) {
    await kvPutJson(
      env,
      nearbyLatestKey({ cell_id: lowerCell, radius_bucket, categories_key }),
      cacheValue,
      nearbyCacheTtlSeconds(env),
    );
  }
}

export async function runPrimeGrouped(env, { lat, lng, radius_m, cell_id, radius_bucket, categories_key, candidates }) {
  const nowSeconds = Math.floor(Date.now() / 1000);

  let llmText;
  llmText = await callNearbyLLM({
    env,
    systemPrompt: NEARBY_SYSTEM_PROMPT,
    payload: { lat, lng, radius_m, candidates, user_context: undefined },
    timeoutMs: 20_000,
    retries: 1,
  });

  const responseUnknown = parseJsonLoose(llmText);
  const { response, meta } = sanitizeNearbyResponse(responseUnknown, { lat, lng, radius_m, candidates });
  safeLog(env, "[prime_queue] sanitize", meta);

  const resultPayload = {
    query: response.query,
    candidates,
    categories: response.categories,
  };

  const etag = await computeEtag(resultPayload);
  const cacheValue = {
    etag,
    produced_at: nowSeconds,
    payload: resultPayload,
    accuracy: "exact",
  };

  await storeNearbyLatest(env, { cell_id, radius_bucket, categories_key, cacheValue });
  return { etag, payload: resultPayload };
}

export async function processQueuedPrimeIfAny(env, { cell_id, radius_bucket, categories_key, candidates }) {
  const jobKey = primeQueueKey({ cell_id, radius_bucket, categories_key });
  const job = await kvGetJson(env, jobKey);
  if (!job || !isObject(job) || job.status !== "queued") return null;

  const lat = typeof job.lat === "number" ? job.lat : null;
  const lng = typeof job.lng === "number" ? job.lng : null;
  const radius_m = typeof job.radius_m === "number" ? job.radius_m : radius_bucket;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  await kvPutJson(
    env,
    jobKey,
    { ...job, status: "processing", processing_at: nowSeconds, last_seen_candidates_at: nowSeconds, candidates_count: candidates.length },
    PRIME_QUEUE_TTL_SECONDS,
  );

  try {
    const result = await runPrimeGrouped(env, { lat, lng, radius_m, cell_id, radius_bucket, categories_key, candidates });
    await kvPutJson(
      env,
      jobKey,
      { ...job, status: "ok", processed_at: Math.floor(Date.now() / 1000), etag: result.etag },
      PRIME_QUEUE_TTL_SECONDS,
    );
    return result;
  } catch (err) {
    await kvPutJson(
      env,
      jobKey,
      { ...job, status: "error", error_at: Math.floor(Date.now() / 1000), error: String(err) },
      PRIME_QUEUE_TTL_SECONDS,
    );
    throw err;
  }
}

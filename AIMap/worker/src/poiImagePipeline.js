import { sha256Hex } from "./etag.js";
import { parseJsonLoose } from "./sanitize.js";
import { safeLog } from "./utils.js";
import {
  listCandidatesForFilterBatch,
  listCandidatesForThumbBatch,
  setCandidateThumbReady,
  setCandidateVerdict,
  upsertApprovedPoiImage,
} from "./poiImageDb.js";
import { callPoiImageFilterLLM } from "./poiImageOpenAI.js";

function requireR2(env) {
  const bucket = env?.POI_IMAGES;
  if (!bucket || typeof bucket.get !== "function" || typeof bucket.put !== "function") {
    throw new Error("Missing R2 binding POI_IMAGES");
  }
  return bucket;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function urlHashShort(url) {
  const hex = await sha256Hex(url);
  return hex.slice(0, 16);
}

export async function makeThumbKey({ poi_id, source_url }) {
  const h = await urlHashShort(source_url);
  return `thumbs/poi/${poi_id}/${h}_thumb.jpg`;
}

export async function makeFullKey({ poi_id, source_url }) {
  const h = await urlHashShort(source_url);
  return `full/poi/${poi_id}/${h}.jpg`;
}

async function fetchImageAsJpeg(sourceUrl, { width, quality }) {
  const res = await fetch(sourceUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": "AIMap/1.0 (poiimage)",
      accept: "image/*,*/*;q=0.8",
    },
    cf: {
      image: {
        format: "jpeg",
        width,
        fit: "scale-down",
        quality,
      },
    },
  });
  if (!res.ok) throw new Error(`Image fetch failed HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return { arrayBuffer: buf, contentType: "image/jpeg" };
}

export async function generateThumbBatch(env, { limit }) {
  const bucket = requireR2(env);
  const candidates = await listCandidatesForThumbBatch(env, { limit });
  const results = [];

  for (const row of candidates) {
    const id = row?.id;
    const poi_id = row?.poi_id;
    const source_url = row?.source_url;
    if (!Number.isInteger(id) || typeof poi_id !== "string" || typeof source_url !== "string") continue;

    let thumbKey;
    try {
      thumbKey = await makeThumbKey({ poi_id, source_url });

      const existing = await bucket.head(thumbKey);
      if (!existing) {
        const { arrayBuffer, contentType } = await fetchImageAsJpeg(source_url, { width: 256, quality: 35 });
        if (arrayBuffer.byteLength > 550_000) {
          throw new Error(`Thumb too large (${arrayBuffer.byteLength} bytes)`);
        }

        await bucket.put(thumbKey, arrayBuffer, {
          httpMetadata: {
            contentType,
            cacheControl: "public, max-age=31536000, immutable",
          },
          customMetadata: { poi_id, source_url },
        });
      }

      await setCandidateThumbReady(env, { id, thumb_r2_key: thumbKey });
      results.push({ id, poi_id, status: "ok", thumb_r2_key: thumbKey });
    } catch (err) {
      safeLog(env, "[poiimage] thumb error", { id, poi_id, err: String(err) });
      results.push({ id, poi_id, status: "error", error: String(err), thumb_r2_key: thumbKey ?? null });
    }
  }

  return { processed: results.length, results };
}

function normalizeVerdict(raw) {
  if (typeof raw !== "string") return "REJECTED";
  const upper = raw.toUpperCase();
  if (upper === "SAFE" || upper === "UNSAFE" || upper === "REJECTED") return upper;
  return "REJECTED";
}

export async function filterBatch(env, { limit }) {
  if (!env?.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const bucket = requireR2(env);
  const candidates = await listCandidatesForFilterBatch(env, { limit });
  const results = [];

  for (const row of candidates) {
    const id = row?.id;
    const poi_id = row?.poi_id;
    const source_url = row?.source_url;
    const thumb_r2_key = row?.thumb_r2_key;

    if (!Number.isInteger(id)) continue;
    if (typeof poi_id !== "string" || poi_id.length === 0) continue;
    if (typeof source_url !== "string" || source_url.length === 0) continue;
    if (typeof thumb_r2_key !== "string" || thumb_r2_key.length === 0) continue;

    let verdict = "REJECTED";
    let reason = "";
    let confidence = 0;
    let fullKey = null;

    try {
      const obj = await bucket.get(thumb_r2_key);
      if (!obj) throw new Error("Thumb missing in R2");
      const thumbBytes = await obj.arrayBuffer();
      if (thumbBytes.byteLength > 700_000) throw new Error(`Thumb too large for LLM (${thumbBytes.byteLength} bytes)`);
      const base64 = toBase64(thumbBytes);

      const llmText = await callPoiImageFilterLLM({
        env,
        poi_id,
        source_url,
        thumbBase64: base64,
        timeoutMs: 15_000,
        retries: 0,
      });

      const parsed = parseJsonLoose(llmText);
      verdict = normalizeVerdict(parsed?.verdict);
      reason = typeof parsed?.reason === "string" ? parsed.reason.slice(0, 240) : "";
      confidence = clamp01(typeof parsed?.confidence === "number" ? parsed.confidence : Number.parseFloat(parsed?.confidence));

      await setCandidateVerdict(env, { id, verdict, reason, confidence });

      if (verdict === "SAFE") {
        fullKey = await makeFullKey({ poi_id, source_url });
        const existing = await bucket.head(fullKey);
        if (!existing) {
          const { arrayBuffer, contentType } = await fetchImageAsJpeg(source_url, { width: 1600, quality: 80 });
          if (arrayBuffer.byteLength > 4_500_000) {
            throw new Error(`Full image too large (${arrayBuffer.byteLength} bytes)`);
          }
          await bucket.put(fullKey, arrayBuffer, {
            httpMetadata: {
              contentType,
              cacheControl: "public, max-age=31536000, immutable",
            },
            customMetadata: { poi_id, source_url },
          });
        }

        await upsertApprovedPoiImage(env, {
          poi_id,
          source_url,
          r2_key_full: fullKey,
          r2_key_thumb: thumb_r2_key,
          score: confidence,
        });
      }

      results.push({
        id,
        poi_id,
        verdict,
        confidence,
        thumb_r2_key,
        full_r2_key: fullKey,
        status: "ok",
      });
    } catch (err) {
      safeLog(env, "[poiimage] filter error", { id, poi_id, err: String(err) });
      results.push({ id, poi_id, status: "error", error: String(err), thumb_r2_key });
    }
  }

  return { processed: results.length, results };
}


import { jsonResponse, errorResponse } from "./utils.js";
import { listApprovedPoiImages } from "./poiImageDb.js";

function requireR2(env) {
  const bucket = env?.POI_IMAGES;
  if (!bucket || typeof bucket.get !== "function") {
    throw new Error("Missing R2 binding POI_IMAGES");
  }
  return bucket;
}

function isAllowedKey(key) {
  if (typeof key !== "string" || key.length === 0) return false;
  if (key.includes("..")) return false;
  return key.startsWith("thumbs/poi/") || key.startsWith("full/poi/");
}

export async function handlePoiImagesApi(request, env) {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter((p) => p.length > 0);
    // /api/poi/:poi_id/images
    if (parts.length !== 4) return errorResponse("Not found", 404);
    if (parts[0] !== "api" || parts[1] !== "poi" || parts[3] !== "images") return errorResponse("Not found", 404);

    const poi_id = decodeURIComponent(parts[2] ?? "");
    if (!poi_id) return errorResponse("Invalid poi_id", 400);

    const rows = await listApprovedPoiImages(env, { poi_id, limit: 3 });
    const images = rows.map((r) => ({
      poi_id: r.poi_id,
      source_url: r.source_url,
      score: r.score,
      thumb_url: `/img/${r.r2_key_thumb}`,
      full_url: `/img/${r.r2_key_full}`,
      r2_key_thumb: r.r2_key_thumb,
      r2_key_full: r.r2_key_full,
    }));

    return jsonResponse({ poi_id, images });
  } catch (err) {
    return errorResponse("POI images lookup failed", 500, String(err));
  }
}

export async function handleImageProxy(request, env) {
  try {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/img/")) return errorResponse("Not found", 404);
    const raw = url.pathname.slice("/img/".length);
    const key = decodeURIComponent(raw);
    if (!isAllowedKey(key)) return errorResponse("Not found", 404);

    const bucket = requireR2(env);
    const obj = await bucket.get(key);
    if (!obj) return errorResponse("Not found", 404);

    const etag = obj?.etag ? `"${obj.etag}"` : null;
    const ifNoneMatch = request.headers.get("if-none-match");
    if (etag && ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          etag,
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    const headers = new Headers();
    const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
    headers.set("content-type", contentType);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    if (etag) headers.set("etag", etag);

    return new Response(obj.body, { status: 200, headers });
  } catch (err) {
    return errorResponse("Image proxy failed", 500, String(err));
  }
}

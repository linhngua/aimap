import { safeLog } from "./utils.js";
import { upsertImageCandidate } from "./poiImageDb.js";

function isLikelyJunkImageUrl(urlString) {
  const lower = urlString.toLowerCase();
  if (lower.startsWith("data:")) return true;
  if (lower.endsWith(".svg")) return true;
  if (lower.endsWith(".ico")) return true;
  if (lower.includes("favicon")) return true;
  if (lower.includes("sprite")) return true;
  if (lower.includes("/icons/")) return true;
  if (lower.includes("logo")) return true;
  return false;
}

function normalizeAbsoluteUrl(maybeUrl, baseUrl) {
  if (typeof maybeUrl !== "string") return null;
  const trimmed = maybeUrl.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  if (trimmed.startsWith("data:")) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseTagAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:\\-\\.]+)\s*=\s*["']([^"']*)["']/g;
  let match;
  while ((match = re.exec(tag)) !== null) {
    const key = String(match[1] ?? "").toLowerCase();
    if (!key) continue;
    attrs[key] = match[2] ?? "";
  }
  return attrs;
}

function extractFromMeta(html) {
  const out = [];
  const re = /<meta\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0] ?? "";
    const attrs = parseTagAttributes(tag);
    const property = (attrs.property ?? "").toLowerCase();
    const name = (attrs.name ?? "").toLowerCase();
    const content = attrs.content ?? "";

    if (!content) continue;
    if (property === "og:image") out.push(content);
    if (name === "twitter:image" || property === "twitter:image") out.push(content);
  }
  return out;
}

function extractFromLinkRel(html) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0] ?? "";
    const attrs = parseTagAttributes(tag);
    const rel = (attrs.rel ?? "").toLowerCase();
    const href = attrs.href ?? "";
    if (rel === "image_src" && href) out.push(href);
  }
  return out;
}

function extractFromImgTags(html) {
  const out = [];
  const re = /<img\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0] ?? "";
    const attrs = parseTagAttributes(tag);
    const src = attrs.src ?? "";
    if (src) out.push(src);
  }
  return out;
}

export function extractCandidateImageUrlsFromHtml(html, baseUrl) {
  if (typeof html !== "string" || html.length === 0) return [];
  const raw = [];

  raw.push(...extractFromMeta(html));
  raw.push(...extractFromLinkRel(html));
  raw.push(...extractFromImgTags(html));

  const normalized = [];
  const seen = new Set();
  for (const item of raw) {
    const abs = normalizeAbsoluteUrl(item, baseUrl);
    if (!abs) continue;
    if (isLikelyJunkImageUrl(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    normalized.push(abs);
  }
  return normalized;
}

export async function crawlOnePoiWebsite(env, { poi_id, website_url, maxCandidates = 5 }) {
  if (typeof poi_id !== "string" || poi_id.length === 0) throw new Error("Invalid poi_id");
  if (typeof website_url !== "string" || website_url.length === 0) throw new Error("Invalid website_url");

  const res = await fetch(website_url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": "AIMap/1.0 (poiimage-crawl)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`Website fetch failed HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error(`Website content-type not HTML: ${contentType}`);
  }

  const html = await res.text();
  const baseUrl = res.url || website_url;

  const candidates = extractCandidateImageUrlsFromHtml(html.slice(0, 1_500_000), baseUrl).slice(0, maxCandidates);
  for (const source_url of candidates) {
    await upsertImageCandidate(env, { poi_id, source_url });
  }

  safeLog(env, "[poiimage] crawl_one", { poi_id, website_url, extracted: candidates.length });
  return { poi_id, website_url, extracted: candidates.length, candidates };
}

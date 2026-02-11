function requireDb(env) {
  const db = env?.IMAGE_CELL_DB ?? env?.DB;
  if (!db || typeof db.prepare !== "function") {
    throw new Error("Missing D1 binding IMAGE_CELL_DB");
  }
  return db;
}

export async function upsertPoiWebsite(env, { poi_id, website_url, cell_id }) {
  if (typeof poi_id !== "string" || poi_id.length === 0) throw new Error("Invalid poi_id");
  if (typeof website_url !== "string" || website_url.length === 0) throw new Error("Invalid website_url");
  const db = requireDb(env);
  const now = Date.now();
  const cellId = typeof cell_id === "string" && cell_id.length > 0 ? cell_id : null;

  try {
    await db
      .prepare(
        `INSERT INTO poi_websites (poi_id, website_url, cell_id, updated_at, enabled)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(poi_id) DO UPDATE SET website_url=excluded.website_url, cell_id=excluded.cell_id, updated_at=excluded.updated_at, enabled=1`,
      )
      .bind(poi_id, website_url, cellId, now)
      .run();
  } catch (err) {
    const message = String(err);
    if (!message.includes("cell_id")) throw err;

    // Back-compat with older D1 schema (no `cell_id` column).
    await db
      .prepare(
        `INSERT INTO poi_websites (poi_id, website_url, updated_at, enabled)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(poi_id) DO UPDATE SET website_url=excluded.website_url, updated_at=excluded.updated_at, enabled=1`,
      )
      .bind(poi_id, website_url, now)
      .run();
  }
}

export async function getCrawlCursor(env) {
  const db = requireDb(env);
  const row = await db
    .prepare("SELECT date, last_poi_id, offset, updated_at FROM poi_crawl_cursor WHERE cursor_key='daily'")
    .first();
  if (!row) {
    return { date: "", last_poi_id: "", offset: 0, updated_at: 0 };
  }
  return {
    date: typeof row.date === "string" ? row.date : "",
    last_poi_id: typeof row.last_poi_id === "string" ? row.last_poi_id : "",
    offset: Number.isInteger(row.offset) ? row.offset : 0,
    updated_at: Number.isInteger(row.updated_at) ? row.updated_at : 0,
  };
}

export async function setCrawlCursor(env, { date, last_poi_id, offset }) {
  const db = requireDb(env);
  const now = Date.now();
  await db
    .prepare(
      `INSERT OR REPLACE INTO poi_crawl_cursor (cursor_key, date, last_poi_id, offset, updated_at)
       VALUES ('daily', ?, ?, ?, ?)`,
    )
    .bind(date ?? "", last_poi_id ?? "", Number.isInteger(offset) ? offset : 0, now)
    .run();
}

export async function listNextPoiWebsitesToCrawl(env, { today, last_poi_id, limit }) {
  const db = requireDb(env);
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 10;
  const res = await db
    .prepare(
      `SELECT poi_id, website_url
       FROM poi_websites
       WHERE enabled = 1
         AND (last_crawled_date IS NULL OR last_crawled_date != ?)
         AND poi_id > ?
       ORDER BY poi_id ASC
       LIMIT ?`,
    )
    .bind(today, last_poi_id ?? "", safeLimit)
    .all();
  const rows = Array.isArray(res?.results) ? res.results : [];
  return rows
    .map((r) => ({
      poi_id: typeof r.poi_id === "string" ? r.poi_id : "",
      website_url: typeof r.website_url === "string" ? r.website_url : "",
    }))
    .filter((r) => r.poi_id.length > 0 && r.website_url.length > 0);
}

export async function markPoiWebsiteCrawled(env, { poi_id, date }) {
  const db = requireDb(env);
  const now = Date.now();
  try {
    await db
      .prepare("UPDATE poi_websites SET last_crawled_date=?, last_crawled_at=?, updated_at=? WHERE poi_id=?")
      .bind(date, now, now, poi_id)
      .run();
  } catch (err) {
    const message = String(err);
    if (!message.includes("last_crawled_at")) throw err;
    await db
      .prepare("UPDATE poi_websites SET last_crawled_date=?, updated_at=? WHERE poi_id=?")
      .bind(date, now, poi_id)
      .run();
  }
}

export async function recordPoiWebsiteHit(env, { poi_id, cell_id }) {
  const db = requireDb(env);
  const now = Date.now();
  const cellId = typeof cell_id === "string" && cell_id.length > 0 ? cell_id : null;

  try {
    await db
      .prepare(
        `UPDATE poi_websites
         SET hit_count=COALESCE(hit_count, 0) + 1,
             last_hit_at=?,
             cell_id=COALESCE(cell_id, ?),
             updated_at=?
         WHERE poi_id=?`,
      )
      .bind(now, cellId, now, poi_id)
      .run();
  } catch (err) {
    const message = String(err);
    if (!message.includes("hit_count") && !message.includes("last_hit_at")) throw err;
    // Back-compat: ignore if the hit counter columns don't exist yet.
  }
}

export async function listPoiWebsitesForCrawlBatch(env, { limit }) {
  const db = requireDb(env);
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 10;

  try {
    const res = await db
      .prepare(
        `SELECT poi_id, website_url, hit_count, last_crawled_at, last_hit_at
         FROM poi_websites
         WHERE enabled = 1
         ORDER BY
           COALESCE(last_crawled_at, 0) ASC,
           COALESCE(hit_count, 0) DESC,
           COALESCE(last_hit_at, 0) DESC,
           updated_at DESC
         LIMIT ?`,
      )
      .bind(safeLimit)
      .all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    return rows
      .map((r) => ({
        poi_id: typeof r.poi_id === "string" ? r.poi_id : "",
        website_url: typeof r.website_url === "string" ? r.website_url : "",
        hit_count: typeof r.hit_count === "number" ? r.hit_count : 0,
        last_crawled_at: typeof r.last_crawled_at === "number" ? r.last_crawled_at : null,
        last_hit_at: typeof r.last_hit_at === "number" ? r.last_hit_at : null,
      }))
      .filter((r) => r.poi_id.length > 0 && r.website_url.length > 0);
  } catch (err) {
    const message = String(err);
    if (!message.includes("hit_count") && !message.includes("last_crawled_at") && !message.includes("last_hit_at")) {
      throw err;
    }

    // Back-compat: older schema, no hit counters.
    const res = await db
      .prepare(
        `SELECT poi_id, website_url, last_crawled_date, updated_at
         FROM poi_websites
         WHERE enabled = 1
         ORDER BY
           CASE WHEN last_crawled_date IS NULL THEN 0 ELSE 1 END ASC,
           last_crawled_date ASC,
           updated_at DESC
         LIMIT ?`,
      )
      .bind(safeLimit)
      .all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    return rows
      .map((r) => ({
        poi_id: typeof r.poi_id === "string" ? r.poi_id : "",
        website_url: typeof r.website_url === "string" ? r.website_url : "",
        hit_count: 0,
        last_crawled_at: null,
        last_hit_at: null,
      }))
      .filter((r) => r.poi_id.length > 0 && r.website_url.length > 0);
  }
}

export async function upsertImageCandidate(env, { poi_id, source_url }) {
  const db = requireDb(env);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO poi_image_candidates (poi_id, source_url, status, discovered_at, last_seen_at)
       VALUES (?, ?, 'NEW', ?, ?)
       ON CONFLICT(poi_id, source_url) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
    )
    .bind(poi_id, source_url, now, now)
    .run();
}

export async function countCandidatesByStatus(env, { status }) {
  const db = requireDb(env);
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM poi_image_candidates WHERE status=?")
    .bind(status)
    .first();
  const count = row?.count;
  return typeof count === "number" && Number.isInteger(count) ? count : 0;
}

export async function listCandidatesForThumbBatch(env, { limit }) {
  const db = requireDb(env);
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 20;
  const res = await db
    .prepare(
      `SELECT id, poi_id, source_url
       FROM poi_image_candidates
       WHERE status='NEW'
       ORDER BY discovered_at ASC
       LIMIT ?`,
    )
    .bind(safeLimit)
    .all();
  return Array.isArray(res?.results) ? res.results : [];
}

export async function setCandidateThumbReady(env, { id, thumb_r2_key }) {
  const db = requireDb(env);
  await db
    .prepare(
      `UPDATE poi_image_candidates
       SET status='THUMB_READY', thumb_r2_key=?
       WHERE id=?`,
    )
    .bind(thumb_r2_key, id)
    .run();
}

export async function listCandidatesForFilterBatch(env, { limit }) {
  const db = requireDb(env);
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 10;
  const res = await db
    .prepare(
      `SELECT id, poi_id, source_url, thumb_r2_key
       FROM poi_image_candidates
       WHERE status='THUMB_READY'
       ORDER BY discovered_at ASC
       LIMIT ?`,
    )
    .bind(safeLimit)
    .all();
  return Array.isArray(res?.results) ? res.results : [];
}

export async function setCandidateVerdict(env, { id, verdict, reason, confidence }) {
  const db = requireDb(env);
  const normalized = typeof verdict === "string" ? verdict.toUpperCase() : "REJECTED";
  const status = normalized === "SAFE" ? "FILTERED" : "DROPPED";
  await db
    .prepare(
      `UPDATE poi_image_candidates
       SET status=?, verdict=?, verdict_reason=?, verdict_confidence=?
       WHERE id=?`,
    )
    .bind(status, normalized, reason ?? null, Number.isFinite(confidence) ? confidence : null, id)
    .run();
}

export async function upsertApprovedPoiImage(env, { poi_id, source_url, r2_key_full, r2_key_thumb, score }) {
  const db = requireDb(env);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO poi_images (poi_id, source_url, r2_key_full, r2_key_thumb, score, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(poi_id, source_url) DO UPDATE SET
         r2_key_full=excluded.r2_key_full,
         r2_key_thumb=excluded.r2_key_thumb,
         score=excluded.score`,
    )
    .bind(poi_id, source_url, r2_key_full, r2_key_thumb, score, now)
    .run();
}

export async function listApprovedPoiImages(env, { poi_id, limit }) {
  const db = requireDb(env);
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(10, limit)) : 3;
  const res = await db
    .prepare(
      `SELECT poi_id, source_url, r2_key_full, r2_key_thumb, score, created_at
       FROM poi_images
       WHERE poi_id=?
       ORDER BY score DESC, created_at DESC
       LIMIT ?`,
    )
    .bind(poi_id, safeLimit)
    .all();
  return Array.isArray(res?.results) ? res.results : [];
}

import { safeLog } from "./utils.js";
import { crawlOnePoiWebsite } from "./poiImageCrawl.js";
import {
  getCrawlCursor,
  listNextPoiWebsitesToCrawl,
  markPoiWebsiteCrawled,
  setCrawlCursor,
} from "./poiImageDb.js";

function utcDateString(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export async function runPoiImageCron(env, { maxPoisPerTick = 10, timeBudgetMs = 20_000 } = {}) {
  const db = env?.IMAGE_CELL_DB ?? env?.DB;
  if (!db || typeof db.prepare !== "function") {
    safeLog(env, "[poiimage] cron skipped: missing IMAGE_CELL_DB");
    return { status: "skipped", reason: "missing_db" };
  }

  const start = Date.now();
  const today = utcDateString();

  let cursor = await getCrawlCursor(env);
  if (cursor.date !== today) {
    cursor = { date: today, last_poi_id: "", offset: 0 };
  }

  const batch = await listNextPoiWebsitesToCrawl(env, {
    today,
    last_poi_id: cursor.last_poi_id,
    limit: maxPoisPerTick,
  });

  if (batch.length === 0) {
    await setCrawlCursor(env, { date: today, last_poi_id: "", offset: 0 });
    safeLog(env, "[poiimage] cron done: no remaining POIs for today");
    return { status: "ok", processed: 0, remaining: 0 };
  }

  let processed = 0;
  for (const item of batch) {
    const elapsed = Date.now() - start;
    if (elapsed > timeBudgetMs - 1200) break;

    try {
      await crawlOnePoiWebsite(env, { poi_id: item.poi_id, website_url: item.website_url, maxCandidates: 5 });
      await markPoiWebsiteCrawled(env, { poi_id: item.poi_id, date: today });
    } catch (err) {
      safeLog(env, "[poiimage] cron crawl error", { poi_id: item.poi_id, err: String(err) });
    }

    processed += 1;
    cursor.last_poi_id = item.poi_id;
    cursor.offset = (Number.isInteger(cursor.offset) ? cursor.offset : 0) + 1;
  }

  await setCrawlCursor(env, cursor);
  safeLog(env, "[poiimage] cron tick", { processed, last_poi_id: cursor.last_poi_id });
  return { status: "ok", processed, last_poi_id: cursor.last_poi_id };
}

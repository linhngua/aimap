-- AIMap POI image system (D1 schema)
--
-- Tables:
-- - poi_websites: seed list of POI websites to crawl (cron reads from here)
-- - poi_image_candidates: discovered candidate image URLs per POI (no LLM in crawl)
-- - poi_images: approved images per POI (written only after admin LLM filtering)
-- - poi_crawl_cursor: cron cursor state for the daily crawl window

CREATE TABLE IF NOT EXISTS poi_websites (
  poi_id TEXT PRIMARY KEY,
  website_url TEXT NOT NULL,
  cell_id TEXT,
  updated_at INTEGER NOT NULL,
  last_crawled_date TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_poi_websites_cell_id ON poi_websites(cell_id);

CREATE TABLE IF NOT EXISTS poi_image_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poi_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL,
  thumb_r2_key TEXT,
  discovered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  verdict TEXT,
  verdict_reason TEXT,
  verdict_confidence REAL,
  UNIQUE(poi_id, source_url)
);

CREATE INDEX IF NOT EXISTS idx_poi_image_candidates_status ON poi_image_candidates(status);
CREATE INDEX IF NOT EXISTS idx_poi_image_candidates_poi_id ON poi_image_candidates(poi_id);

CREATE TABLE IF NOT EXISTS poi_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poi_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  r2_key_full TEXT NOT NULL,
  r2_key_thumb TEXT NOT NULL,
  score REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(poi_id, source_url)
);

CREATE INDEX IF NOT EXISTS idx_poi_images_poi_id ON poi_images(poi_id);

CREATE TABLE IF NOT EXISTS poi_crawl_cursor (
  cursor_key TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  last_poi_id TEXT,
  offset INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO poi_crawl_cursor (cursor_key, date, last_poi_id, offset, updated_at)
VALUES ('daily', '', '', 0, 0);

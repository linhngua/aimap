-- Migration: add hit counters + crawl timestamps to poi_websites.
--
-- Run once on an existing D1 database that was created before these columns existed:
--   wrangler d1 execute <YOUR_DB_NAME> --file=worker/d1/poi_images_migrate_hits.sql

ALTER TABLE poi_websites ADD COLUMN last_crawled_at INTEGER;
ALTER TABLE poi_websites ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE poi_websites ADD COLUMN last_hit_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_poi_websites_hit_count ON poi_websites(hit_count);
CREATE INDEX IF NOT EXISTS idx_poi_websites_last_crawled_at ON poi_websites(last_crawled_at);


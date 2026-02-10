-- Migration: add `cell_id` to poi_websites for map overlays.
--
-- Run once on an existing D1 database that was created before `cell_id` existed:
--   wrangler d1 execute <YOUR_DB_NAME> --file=worker/d1/poi_images_migrate_cell_id.sql

ALTER TABLE poi_websites ADD COLUMN cell_id TEXT;

CREATE INDEX IF NOT EXISTS idx_poi_websites_cell_id ON poi_websites(cell_id);


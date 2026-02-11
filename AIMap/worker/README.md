# AIMap Worker

Cloudflare Worker backend for the AI-enhanced map feature.

## Endpoints

- `POST /v1/map/candidates_ingest` (store MapKit candidates by area)
- `POST /v1/map/nearby_cached` (cache lookup + nearest-cell fallback)
- `POST /v1/map/nearby_refresh` (LLM refresh + KV write)
- `POST /v1/map/place_detail` (LLM place sheet; cache-first)
  - Alias: `POST /v1/map/place`
- `POST /v1/map/area_facts` (Wikipedia-backed, cache-first)
- Legacy:
  - `POST /v1/map/nearby` (older single-shot endpoint; keep for compatibility)
- `GET /admin` (cache primer UI)
  - `GET /admin/api/cached_cells`
  - `GET /admin/api/candidate_cells`
  - `GET /admin/api/cell_status`
  - `POST /admin/api/prime`
- POI images (D1 + R2):
  - `GET  /admin/poiimage` (admin UI)
  - `GET  /admin/poiimage/status`
  - `POST /admin/poiimage/crawl_one` (manual crawl one POI website; no LLM)
  - `POST /admin/poiimage/crawl_batch` (crawl a prioritized batch from `poi_websites`; no LLM)
  - `POST /admin/poiimage/thumb_batch` (generate low-quality thumbs; no LLM)
  - `POST /admin/poiimage/filter_batch` (admin-only LLM filtering; thumb-only)
  - `GET  /api/poi/:poi_id/images` (approved images only, max 3)
  - `GET  /img/:r2_key` (R2 proxy w/ caching headers)

## Environment

Configure these secrets/bindings:

- `OPENAI_API_KEY` (required for LLM endpoints)
- `OPENAI_MODEL` (optional)
- `OPENAI_IMAGE_MODEL` (optional; POI image filtering; must support vision)
- `OPENAI_BASE_URL` (optional)
- `MODE=Test` (optional; enables verbose logs)
- `ADMIN_TOKEN` (optional; enables `/admin` APIs; must be non-empty)

Cache storage:

- `MAP_CACHE` (Cloudflare KV namespace binding; recommended for production)

POI image storage:

- `IMAGE_CELL_DB` (Cloudflare D1 binding; required for POI image system)
- `POI_IMAGES` (Cloudflare R2 bucket binding; required for POI image system)

Cache tuning (optional):

- `NEARBY_CACHE_TTL_SECONDS` (default: 1 year)
- `NEARBY_STALE_AFTER_SECONDS` (default: 30 days)
- `CANDIDATES_CACHE_TTL_SECONDS` (default: 1 year)
- `PLACE_DETAIL_CACHE_TTL_SECONDS` (default: 1 year)

## Cache strategy (area-based)

Nearby results are cached by **geohash cell** (area), not exact coordinates:

- `candidates_latest:<cell_id>:<radius_bucket>` stores MapKit candidates (max 40)
- `nearby_latest:<cell_id>:<radius_bucket>:<categories_key>` stores grouped LLM output

`/v1/map/nearby_cached` supports nearest-cell fallback:
same-precision neighbors (8) → one lower-precision cell.

## Client flow (cache-first)

1) iOS taps map and fetches candidates via MapKit (max 40)
2) iOS best-effort calls `POST /v1/map/candidates_ingest` (so the server can prime later without re-sending)
3) iOS calls `POST /v1/map/nearby_cached` for instant grouped results if available
4) If miss/stale/approx, iOS calls `POST /v1/map/nearby_refresh` with candidates (LLM call)

## Admin cache primer

The worker includes a simple UI for visualizing cached cells and priming them via LLM:

- Visit `GET /admin`
- Set `ADMIN_TOKEN` in your Worker environment and enter it in the UI (sent as `x-admin-token`)
- Auto Prime runs in your browser session and prioritizes missing cells; it can only prime cells that already have ingested candidates.

## POI image system (cron crawl + admin filter)

Two separate pipelines:

1) **Cron crawl (no LLM):** fetch POI websites daily, extract up to 5 candidate image URLs, and store them in D1.
2) **Admin-only LLM filter (thumb-only):** generate 256px low-quality thumbs in R2, then classify thumbs with a vision model; only SAFE images get the full image stored + approved in D1.

### Setup

1) Create/bind D1 + apply schema:

```bash
wrangler d1 execute <YOUR_DB_NAME> --file=worker/d1/poi_images.sql
```

Optional (existing DB only): add hit counters used for crawl prioritization:

```bash
wrangler d1 execute <YOUR_DB_NAME> --file=worker/d1/poi_images_migrate_hits.sql
```

2) Create/bind R2 bucket `POI_IMAGES` (see `worker/wrangler.toml`).

3) Set env vars:

- `ADMIN_TOKEN` (required for admin APIs)
- `OPENAI_API_KEY` + `OPENAI_IMAGE_MODEL` (required for `/admin/poiimage/filter_batch`)

4) Seed POIs to crawl:

- Visit `GET /admin/poiimage`, enter token, then run “Crawl one” for a POI (`poi_id` + `website_url`).
- Cron uses `poi_websites` as the crawl target list.

### Cron schedule

`worker/wrangler.toml` includes an example cron trigger:

- Every 5 minutes during a 2-hour daily window (UTC).

Notes:

- Cron **never** calls the LLM.
- Thumbnail generation uses Cloudflare’s `cf.image` resizing; ensure Image Resizing is enabled for best results.

## Local dev

`wrangler` is expected to be installed globally.

- `cd worker`
- `wrangler dev`

The iOS app currently ships with a fixed backend base URL; update the constant in `AIMap/MapFeature/MapViewModel.swift` if you want to point at local dev.

## Cache bypass

Send header `x-bypass-cache: 1` to force refresh.

## Quick curl tests

Assuming your worker is deployed at `https://map.petetranfab.com`:

1) Ingest candidates:

```bash
curl -sS https://map.petetranfab.com/v1/map/candidates_ingest \
  -H 'content-type: application/json' \
  -d '{"lat":37.3349,"lng":-122.0090,"radius_m":800,"cell_id":"9q9hv","candidates":[{"place_local_id":"test_1","name":"Test Cafe","lat":37.3349,"lng":-122.0090,"address_short":"1 Infinite Loop","raw_categories":["MKPOICategoryCafe"],"url":null,"phone":null,"rating":4.2,"rating_count":120,"price_level":2,"open_now":true}]}'
```

2) Read cache (will likely miss until refreshed):

```bash
curl -sS https://map.petetranfab.com/v1/map/nearby_cached \
  -H 'content-type: application/json' \
  -d '{"lat":37.3349,"lng":-122.0090,"radius_m":800,"categories":["restaurants","bars","attractions","shops"],"cell_id":"9q9hv","time_bucket":"test","client_etag":null}'
```

3) Refresh grouped nearby (LLM call; requires `OPENAI_API_KEY`):

```bash
curl -sS https://map.petetranfab.com/v1/map/nearby_refresh \
  -H 'content-type: application/json' \
  -d '{"lat":37.3349,"lng":-122.0090,"radius_m":800,"categories":["restaurants","bars","attractions","shops"],"cell_id":"9q9hv","time_bucket":"test","client_etag":null,"candidates":[{"place_local_id":"test_1","name":"Test Cafe","lat":37.3349,"lng":-122.0090,"address_short":"1 Infinite Loop","raw_categories":["MKPOICategoryCafe"],"url":null,"phone":null,"rating":4.2,"rating_count":120,"price_level":2,"open_now":true}]}'
```

Sample request/response fixtures live in `worker/fixtures/`.

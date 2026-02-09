# AIMap Worker

Cloudflare Worker backend for the AI-enhanced map feature.

## Endpoints

- `POST /v1/map/nearby`
- `POST /v1/map/nearby_cached`
- `POST /v1/map/nearby_refresh`
- `POST /v1/map/place`
- `GET /admin` (cache primer UI)

## Environment

Configure these secrets/bindings:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (optional)
- `OPENAI_BASE_URL` (optional)
- `MODE=Test` (optional; enables verbose logs)
- `ADMIN_TOKEN` (optional; enables `/admin` APIs)

Cache storage:

- `MAP_CACHE` (Cloudflare KV namespace binding; recommended for production)

## Admin cache primer

The worker includes a simple UI for visualizing cached cells and priming them via LLM:

- Visit `GET /admin`
- Set `ADMIN_TOKEN` and enter it in the UI (sent as `x-admin-token`)

## Local dev

`wrangler` is expected to be installed globally.

- `cd worker`
- `wrangler dev`

The iOS app currently ships with a fixed backend base URL; update the constant in `AIMap/MapFeature/MapViewModel.swift` if you want to point at local dev.

## Cache bypass

Send header `x-bypass-cache: 1` to force refresh.

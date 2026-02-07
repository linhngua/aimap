# AIMap Worker

Cloudflare Worker backend for the AI-enhanced map feature.

## Endpoints

- `POST /v1/map/nearby`
- `POST /v1/map/place`

## Environment

Configure these secrets/bindings:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (optional)
- `OPENAI_BASE_URL` (optional)

## Local dev

`wrangler` is expected to be installed globally.

- `cd worker`
- `wrangler dev`

Then point the iOS app setting `backend_base_url` at the printed local URL.

## Cache bypass

Send header `x-bypass-cache: 1` to force refresh.

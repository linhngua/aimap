import { callNearbyLLM } from "./openai.js";
import { NEARBY_SYSTEM_PROMPT } from "./prompts.js";
import { sha256Hex, stableStringify } from "./etag.js";
import { geohashCenter, geohashDecodeBounds, geohashEncode, geohashNeighbors, haversineDistanceM } from "./geohash.js";
import { kvGetJson, kvList, kvPutJson } from "./kv.js";
import { PlaceCandidateSchema } from "./schema.js";
import { parseJsonLoose, sanitizeNearbyResponse } from "./sanitize.js";
import { errorResponse, getBypassCache, jsonResponse, safeLog } from "./utils.js";

const FIXED_CATEGORIES = ["restaurants", "bars", "attractions", "shops"];
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const STALE_AFTER_SECONDS = 10 * 60;
const MAX_LLM_CANDIDATES = 40;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireAdminToken(request, env) {
  const expected = env?.ADMIN_TOKEN;
  if (typeof expected !== "string" || expected.length < 12) {
    return { ok: false, response: errorResponse("Admin is disabled (set ADMIN_TOKEN).", 404) };
  }
  const provided = request.headers.get("x-admin-token");
  if (provided !== expected) {
    return { ok: false, response: errorResponse("Unauthorized", 401) };
  }
  return { ok: true, token: expected };
}

function categoriesKey(categories) {
  if (!Array.isArray(categories)) return "rbas";
  const normalized = categories.filter((c) => typeof c === "string").map((c) => c.toLowerCase());
  const unique = Array.from(new Set(normalized)).sort();
  return unique.map((c) => c[0]).join("") || "rbas";
}

function radiusBucket(radius_m) {
  if (!Number.isFinite(radius_m)) return 800;
  if (radius_m <= 400) return 300;
  if (radius_m <= 1100) return 800;
  return 1500;
}

function geohashPrecisionForRadiusBucket(bucket) {
  if (bucket === 300) return 7;
  if (bucket === 800) return 6;
  return 5;
}

function currentTimeBucket(nowSeconds, bucketSeconds = 30 * 60) {
  const bucketStart = Math.floor(nowSeconds / bucketSeconds) * bucketSeconds;
  return String(bucketStart);
}

function nearbyKey({ cell_id, radius_bucket, categories_key, time_bucket }) {
  return `nearby:${cell_id}:${radius_bucket}:${categories_key}:${time_bucket}`;
}

function nearbyLatestKey({ cell_id, radius_bucket, categories_key }) {
  return `nearby_latest:${cell_id}:${radius_bucket}:${categories_key}`;
}

async function computeEtag(payload) {
  return await sha256Hex(stableStringify(payload));
}

function parseCachedKeyName(name) {
  if (typeof name !== "string") return null;
  const parts = name.split(":");
  if (parts.length === 4 && parts[0] === "nearby_latest") {
    const cell_id = parts[1] ?? "";
    const radius_bucket = Number.parseInt(parts[2] ?? "", 10);
    const categories_key = parts[3] ?? "";
    if (!cell_id) return null;
    if (!Number.isInteger(radius_bucket)) return null;
    if (!categories_key) return null;
    return { kind: "latest", cell_id, radius_bucket, categories_key };
  }
  if (parts.length === 5 && parts[0] === "nearby") {
    const cell_id = parts[1] ?? "";
    const radius_bucket = Number.parseInt(parts[2] ?? "", 10);
    const categories_key = parts[3] ?? "";
    const time_bucket = parts[4] ?? "";
    if (!cell_id) return null;
    if (!Number.isInteger(radius_bucket)) return null;
    if (!categories_key) return null;
    if (!time_bucket) return null;
    return { kind: "bucketed", cell_id, radius_bucket, categories_key, time_bucket };
  }
  return null;
}

async function getBestCandidateSource(env, query, { radius_bucket, categories_key, cell_id }) {
  const candidates = [];

  const tryCell = async (candidateCellId) => {
    const key = nearbyLatestKey({ cell_id: candidateCellId, radius_bucket, categories_key });
    const cached = await kvGetJson(env, key);
    if (!cached || !isObject(cached) || !isObject(cached.payload)) return;
    const payload = cached.payload;
    if (!Array.isArray(payload.candidates)) return;
    const parsedCandidates = payload.candidates
      .slice(0, MAX_LLM_CANDIDATES)
      .map((c) => {
        try {
          return PlaceCandidateSchema.parse(c);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (parsedCandidates.length === 0) return;

    const center = geohashCenter(candidateCellId);
    if (!center) return;
    const distance_m = haversineDistanceM({ lat: query.lat, lng: query.lng }, center);
    candidates.push({ candidateCellId, distance_m, candidates: parsedCandidates });
  };

  await tryCell(cell_id);
  for (const neighbor of geohashNeighbors(cell_id)) {
    await tryCell(neighbor);
  }

  if (candidates.length === 0 && cell_id.length > 1) {
    const lower = cell_id.slice(0, -1);
    await tryCell(lower);
    for (const neighbor of geohashNeighbors(lower)) {
      await tryCell(neighbor);
    }
  }

  candidates.sort((a, b) => a.distance_m - b.distance_m);
  return candidates[0] ?? null;
}

function adminHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AIMap Cache Primer</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; background: #070A10; color: #E8E8E8; }
      header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); background: rgba(7,10,16,0.9); position: sticky; top: 0; z-index: 10; }
      header h1 { font-size: 14px; letter-spacing: 0.14em; margin: 0; font-weight: 500; color: rgba(232,232,232,0.9); }
      header .right { display: flex; gap: 10px; align-items: center; }
      input, select, button, textarea { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); color: #E8E8E8; border-radius: 10px; padding: 10px 12px; font-size: 13px; outline: none; }
      input::placeholder, textarea::placeholder { color: rgba(232,232,232,0.5); }
      button { cursor: pointer; }
      button.primary { background: rgba(212,194,140,0.14); border-color: rgba(212,194,140,0.35); }
      button.danger { background: rgba(214,84,84,0.14); border-color: rgba(214,84,84,0.35); }
      main { display: grid; grid-template-columns: 1fr 360px; gap: 0; height: calc(100vh - 53px); }
      #map { height: 100%; width: 100%; }
      aside { border-left: 1px solid rgba(255,255,255,0.08); padding: 14px; overflow: auto; }
      .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 12px; margin-bottom: 12px; }
      .row { display: flex; gap: 10px; align-items: center; }
      .row > * { flex: 1; }
      .label { font-size: 12px; color: rgba(232,232,232,0.7); margin-bottom: 6px; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: rgba(232,232,232,0.9); word-break: break-all; }
      .status { font-size: 12px; line-height: 1.4; color: rgba(232,232,232,0.75); }
      .pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; font-size: 12px; border: 1px solid rgba(255,255,255,0.10); }
      .pill .dot { width: 8px; height: 8px; border-radius: 999px; background: #4CD964; }
      .pill.stale .dot { background: #F7C74A; }
      .pill.miss .dot { background: #6B7280; }
      .muted { color: rgba(232,232,232,0.55); }
      .small { font-size: 12px; }
      .grid { display: grid; gap: 10px; }
      textarea { width: 100%; min-height: 96px; resize: vertical; }
      a { color: rgba(212,194,140,0.92); text-decoration: none; }
    </style>
  </head>
  <body>
    <header>
      <h1>AI MAP · CACHE PRIMER</h1>
      <div class="right">
        <input id="token" placeholder="ADMIN_TOKEN" style="width: 220px" />
        <button id="saveToken" class="primary">Save</button>
      </div>
    </header>
    <main>
      <div id="map"></div>
      <aside>
        <div class="card">
          <div class="label">Cache Overlay</div>
          <div class="row">
            <select id="radius">
              <option value="300">300m</option>
              <option value="800" selected>800m</option>
              <option value="1500">1500m</option>
            </select>
            <button id="refresh" class="primary">Refresh</button>
          </div>
          <div class="status muted small" style="margin-top: 10px">
            Overlay shows cached <span class="mono">nearby_latest</span> cells near the viewport.
          </div>
        </div>

        <div class="card">
          <div class="label">Selected Point</div>
          <div id="selected" class="status muted">Click the map to select a cell to prime.</div>
        </div>

        <div class="card">
          <div class="label">Prime Cache (LLM)</div>
          <div class="grid">
            <button id="prime" class="primary" disabled>Prime selected cell</button>
            <div class="status muted small">
              Priming reuses cached candidates when available (no invented places).
              If a cell has never been cached, paste candidates JSON below or tap it in the iOS app once.
            </div>
            <textarea id="candidates" placeholder='Optional: paste candidates array JSON (max 40)...'></textarea>
            <button id="primeWithCandidates" class="danger" disabled>Prime with pasted candidates</button>
          </div>
        </div>

        <div class="card">
          <div class="label">Notes</div>
          <div class="status">
            <div>API endpoints used:</div>
            <div class="mono">GET /admin/api/cached_cells</div>
            <div class="mono">POST /admin/api/prime</div>
            <div class="muted small" style="margin-top: 10px">
              Add <span class="mono">ADMIN_TOKEN</span> and <span class="mono">MAP_CACHE</span> KV binding for best results.
            </div>
          </div>
        </div>
      </aside>
    </main>

    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
    <script>
      const storedToken = sessionStorage.getItem("aimap_admin_token") || "";
      const tokenInput = document.getElementById("token");
      tokenInput.value = storedToken;

      document.getElementById("saveToken").addEventListener("click", () => {
        const token = tokenInput.value.trim();
        sessionStorage.setItem("aimap_admin_token", token);
        statusLine("Token saved for this session.");
        updateButtons();
        refreshOverlay();
      });

      function adminHeaders() {
        const token = (sessionStorage.getItem("aimap_admin_token") || "").trim();
        return token ? { "x-admin-token": token } : {};
      }

      function updateButtons() {
        const hasToken = (sessionStorage.getItem("aimap_admin_token") || "").trim().length > 0;
        document.getElementById("prime").disabled = !hasToken || !window.__selected;
        document.getElementById("primeWithCandidates").disabled = !hasToken || !window.__selected;
      }

      function statusLine(text) {
        const el = document.getElementById("selected");
        if (el) el.textContent = text;
      }

      const map = L.map("map", { zoomControl: true }).setView([37.3349, -122.0090], 13);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: "abcd",
        maxZoom: 19
      }).addTo(map);

      const overlayLayer = L.layerGroup().addTo(map);
      const selectionLayer = L.layerGroup().addTo(map);

      function formatTs(seconds) {
        if (!seconds) return "unknown";
        const d = new Date(seconds * 1000);
        return d.toLocaleString();
      }

      async function fetchJson(url, init) {
        const res = await fetch(url, init);
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        if (!res.ok) {
          const msg = data && data.error && data.error.message ? data.error.message : text.slice(0, 200);
          throw new Error(msg || ("HTTP " + res.status));
        }
        return data;
      }

      function prefixLenForZoom(zoom, maxPrecision) {
        const base = zoom <= 9 ? 4 : zoom <= 11 ? 5 : 6;
        return Math.max(3, Math.min(base, maxPrecision));
      }

      const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
      function geohashEncode(lat, lng, precision) {
        let even = true, bit = 0, ch = 0, hash = "";
        let latMin = -90.0, latMax = 90.0, lngMin = -180.0, lngMax = 180.0;
        while (hash.length < precision) {
          if (even) {
            const mid = (lngMin + lngMax) / 2;
            if (lng >= mid) { ch = (ch << 1) | 1; lngMin = mid; }
            else { ch = (ch << 1) | 0; lngMax = mid; }
          } else {
            const mid = (latMin + latMax) / 2;
            if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; }
            else { ch = (ch << 1) | 0; latMax = mid; }
          }
          even = !even; bit += 1;
          if (bit === 5) { hash += BASE32[ch]; bit = 0; ch = 0; }
        }
        return hash;
      }

      function precisionForRadiusBucket(bucket) {
        if (bucket === 300) return 7;
        if (bucket === 800) return 6;
        return 5;
      }

      function categoriesKeyFixed() {
        return ["attractions", "bars", "restaurants", "shops"].map(s => s[0]).join("");
      }

      async function refreshOverlay() {
        overlayLayer.clearLayers();
        const token = (sessionStorage.getItem("aimap_admin_token") || "").trim();
        if (!token) return;

        const radiusBucket = parseInt(document.getElementById("radius").value, 10);
        const precision = precisionForRadiusBucket(radiusBucket);
        const prefixLen = prefixLenForZoom(map.getZoom(), precision);

        const bounds = map.getBounds();
        const corners = [
          bounds.getNorthWest(),
          bounds.getNorthEast(),
          bounds.getSouthWest(),
          bounds.getSouthEast()
        ];
        const prefixes = Array.from(new Set(corners.map(p => geohashEncode(p.lat, p.lng, precision).slice(0, prefixLen))));

        const categoriesKey = categoriesKeyFixed();
        let all = [];
        for (const prefix of prefixes) {
          const url = \`/admin/api/cached_cells?cell_prefix=\${encodeURIComponent(prefix)}&radius_bucket=\${radiusBucket}&categories_key=\${encodeURIComponent(categoriesKey)}&limit=400\`;
          const data = await fetchJson(url, { headers: adminHeaders() });
          all = all.concat(data.cells || []);
        }

        const uniqueByCell = new Map();
        for (const cell of all) {
          const key = cell.cell_id + ":" + cell.radius_bucket + ":" + cell.categories_key;
          const existing = uniqueByCell.get(key);
          if (!existing || (cell.produced_at || 0) > (existing.produced_at || 0)) uniqueByCell.set(key, cell);
        }

        for (const cell of uniqueByCell.values()) {
          if (!cell.bounds) continue;
          const b = cell.bounds;
          const rect = L.rectangle([[b.lat_min, b.lng_min], [b.lat_max, b.lng_max]], {
            color: cell.stale ? "#F7C74A" : "#4CD964",
            weight: 1,
            opacity: 0.6,
            fillOpacity: cell.stale ? 0.08 : 0.10
          });
          rect.bindTooltip(\`cell \${cell.cell_id} • \${cell.stale ? "stale" : "fresh"} • \${formatTs(cell.produced_at)}\`, { sticky: true });
          rect.addTo(overlayLayer);
        }
      }

      document.getElementById("refresh").addEventListener("click", () => refreshOverlay().catch(err => statusLine("Overlay error: " + err.message)));
      document.getElementById("radius").addEventListener("change", () => refreshOverlay().catch(err => statusLine("Overlay error: " + err.message)));
      map.on("moveend", () => refreshOverlay().catch(() => {}));

      map.on("click", (e) => {
        selectionLayer.clearLayers();
        const marker = L.circleMarker(e.latlng, { radius: 6, color: "#D84A4A", weight: 2, fillOpacity: 0.25 });
        marker.addTo(selectionLayer);
        window.__selected = { lat: e.latlng.lat, lng: e.latlng.lng };
        statusLine(\`Selected: \${e.latlng.lat.toFixed(6)}, \${e.latlng.lng.toFixed(6)}\`);
        updateButtons();
      });

      async function primeSelected(withCandidates) {
        if (!window.__selected) return;
        const radiusBucket = parseInt(document.getElementById("radius").value, 10);
        let candidates = null;
        if (withCandidates) {
          const raw = document.getElementById("candidates").value.trim();
          if (!raw) throw new Error("Paste candidates JSON first.");
          candidates = JSON.parse(raw);
        }
        statusLine("Priming…");
        updateButtons();

        const body = {
          lat: window.__selected.lat,
          lng: window.__selected.lng,
          radius_m: radiusBucket,
          categories: ["restaurants","bars","attractions","shops"],
          candidates
        };
        const data = await fetchJson("/admin/api/prime", {
          method: "POST",
          headers: { "content-type": "application/json", ...adminHeaders() },
          body: JSON.stringify(body)
        });
        statusLine(\`Primed: \${data.cell_id} • \${data.status} • etag=\${(data.etag||"").slice(0,10)}…\`);
        await refreshOverlay();
      }

      document.getElementById("prime").addEventListener("click", () => primeSelected(false).catch(err => statusLine("Prime error: " + err.message)));
      document.getElementById("primeWithCandidates").addEventListener("click", () => primeSelected(true).catch(err => statusLine("Prime error: " + err.message)));

      updateButtons();
      refreshOverlay().catch(() => {});
    </script>
  </body>
</html>`;
}

async function handleAdminPage() {
  return new Response(adminHtml(), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleAdmin(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
    return await handleAdminPage();
  }

  if (url.pathname === "/admin/api/cached_cells" && request.method === "GET") {
    const auth = requireAdminToken(request, env);
    if (!auth.ok) return auth.response;

    const cellPrefix = url.searchParams.get("cell_prefix") ?? "";
    const radiusBucketParam = Number.parseInt(url.searchParams.get("radius_bucket") ?? "", 10);
    const radiusBucketFilter = Number.isInteger(radiusBucketParam) ? radiusBucketParam : null;
    const categoriesKeyFilter = url.searchParams.get("categories_key");
    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isInteger(limitParam) ? Math.min(800, Math.max(1, limitParam)) : 200;

    const listPrefix = `nearby_latest:${cellPrefix}`;
    const listed = await kvList(env, { prefix: listPrefix, limit });
    const nowSeconds = Math.floor(Date.now() / 1000);

    const keys = Array.isArray(listed?.keys) ? listed.keys : [];
    const candidates = keys
      .map((k) => parseCachedKeyName(k?.name))
      .filter((parsed) => parsed?.kind === "latest")
      .filter((parsed) => (radiusBucketFilter ? parsed.radius_bucket === radiusBucketFilter : true))
      .filter((parsed) => (typeof categoriesKeyFilter === "string" && categoriesKeyFilter.length > 0 ? parsed.categories_key === categoriesKeyFilter : true));

    const cells = [];
    for (const entry of candidates) {
      const key = nearbyLatestKey(entry);
      const cached = await kvGetJson(env, key);
      if (!cached || !isObject(cached)) continue;
      const produced_at = typeof cached.produced_at === "number" ? cached.produced_at : 0;
      const etag = typeof cached.etag === "string" ? cached.etag : null;
      const bounds = geohashDecodeBounds(entry.cell_id);
      if (!bounds) continue;
      const stale = produced_at > 0 ? nowSeconds - produced_at > STALE_AFTER_SECONDS : true;

      const payload = cached.payload;
      const counts = isObject(payload?.categories)
        ? {
            restaurants: Array.isArray(payload.categories?.restaurants) ? payload.categories.restaurants.length : 0,
            bars: Array.isArray(payload.categories?.bars) ? payload.categories.bars.length : 0,
            attractions: Array.isArray(payload.categories?.attractions) ? payload.categories.attractions.length : 0,
            shops: Array.isArray(payload.categories?.shops) ? payload.categories.shops.length : 0,
          }
        : null;

      cells.push({
        cell_id: entry.cell_id,
        radius_bucket: entry.radius_bucket,
        categories_key: entry.categories_key,
        produced_at,
        stale,
        etag,
        counts,
        bounds: {
          lat_min: bounds.latMin,
          lat_max: bounds.latMax,
          lng_min: bounds.lngMin,
          lng_max: bounds.lngMax,
        },
      });
    }

    return jsonResponse({
      cells,
      list_complete: listed?.list_complete ?? true,
      cursor: listed?.cursor ?? "",
    });
  }

  if (url.pathname === "/admin/api/prime" && request.method === "POST") {
    const auth = requireAdminToken(request, env);
    if (!auth.ok) return auth.response;
    if (!env.OPENAI_API_KEY) return errorResponse("Missing OPENAI_API_KEY", 500);

    let bodyUnknown;
    try {
      bodyUnknown = await request.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    if (!isObject(bodyUnknown)) return errorResponse("Invalid request", 400);
    const lat = bodyUnknown.lat;
    const lng = bodyUnknown.lng;
    const radius_m = bodyUnknown.radius_m;
    if (typeof lat !== "number" || typeof lng !== "number") return errorResponse("Invalid lat/lng", 400);
    if (typeof radius_m !== "number" || !Number.isInteger(radius_m) || radius_m <= 0) return errorResponse("Invalid radius_m", 400);

    const categories = Array.isArray(bodyUnknown.categories) ? bodyUnknown.categories : FIXED_CATEGORIES;
    const categories_key = categoriesKey(categories);
    const bucket = radiusBucket(radius_m);
    const precision = geohashPrecisionForRadiusBucket(bucket);
    const cell_id = typeof bodyUnknown.cell_id === "string" && bodyUnknown.cell_id.length > 0 ? bodyUnknown.cell_id : geohashEncode(lat, lng, precision);
    const time_bucket =
      typeof bodyUnknown.time_bucket === "string" && bodyUnknown.time_bucket.length > 0
        ? bodyUnknown.time_bucket
        : currentTimeBucket(Math.floor(Date.now() / 1000));

    const bypassCache = getBypassCache(request);

    let candidates = null;
    let candidateSource = { accuracy: "exact", source_cell_id: null, source_distance_m: null };
    if (Array.isArray(bodyUnknown.candidates) && bodyUnknown.candidates.length > 0) {
      const trimmed = bodyUnknown.candidates.slice(0, MAX_LLM_CANDIDATES);
      try {
        candidates = trimmed.map((c) => PlaceCandidateSchema.parse(c));
      } catch (err) {
        return errorResponse("Invalid candidates", 400, String(err));
      }
    } else {
      const best = await getBestCandidateSource(env, { lat, lng }, { radius_bucket: bucket, categories_key, cell_id });
      if (!best) {
        return errorResponse(
          "No cached candidates found for this area. Tap it in the iOS app once or paste candidates JSON.",
          404,
        );
      }
      candidates = best.candidates;
      if (best.candidateCellId !== cell_id) {
        candidateSource = {
          accuracy: "approx",
          source_cell_id: best.candidateCellId,
          source_distance_m: Math.round(best.distance_m),
        };
      }
    }

    safeLog(env, "[admin prime] request", {
      cell_id,
      radius_bucket: bucket,
      time_bucket,
      bypass_cache: bypassCache,
      candidates: candidates.length,
    });

    let llmText;
    try {
      llmText = await callNearbyLLM({
        env,
        systemPrompt: NEARBY_SYSTEM_PROMPT,
        payload: { lat, lng, radius_m, candidates, user_context: undefined },
        timeoutMs: 20_000,
        retries: 1,
      });
    } catch (err) {
      return errorResponse("LLM request failed", 502, String(err));
    }

    const responseUnknown = parseJsonLoose(llmText);
    const { response, meta } = sanitizeNearbyResponse(responseUnknown, { lat, lng, radius_m, candidates });
    safeLog(env, "[admin prime] sanitize", meta);

    const resultPayload = {
      query: response.query,
      candidates,
      categories: response.categories,
    };

    const etag = await computeEtag(resultPayload);

    const cacheValue = {
      etag,
      produced_at: Math.floor(Date.now() / 1000),
      payload: resultPayload,
      accuracy: candidateSource.accuracy,
      source_cell_id: candidateSource.source_cell_id,
      source_distance_m: candidateSource.source_distance_m,
    };

    const bucketKey = nearbyKey({ cell_id, radius_bucket: bucket, categories_key, time_bucket });
    const latestKey = nearbyLatestKey({ cell_id, radius_bucket: bucket, categories_key });
    await kvPutJson(env, bucketKey, cacheValue, CACHE_TTL_SECONDS);
    await kvPutJson(env, latestKey, cacheValue, CACHE_TTL_SECONDS);

    return jsonResponse({ status: "ok", cell_id, etag });
  }

  return errorResponse("Not found", 404);
}

import { callNearbyLLM } from "./openai.js";
import { NEARBY_SYSTEM_PROMPT } from "./prompts.js";
import { sha256Hex, stableStringify } from "./etag.js";
import { geohashCenter, geohashDecodeBounds, geohashEncode } from "./geohash.js";
import { kvGetJson, kvList, kvPutJson } from "./kv.js";
import { PlaceCandidateSchema } from "./schema.js";
import { parseJsonLoose, sanitizeNearbyResponse } from "./sanitize.js";
import { errorResponse, getBypassCache, jsonResponse, safeLog } from "./utils.js";
import { candidatesLatestKey, findBestCandidates, ingestCandidates } from "./candidatesStore.js";
import { candidatesCacheTtlSeconds, nearbyCacheTtlSeconds, nearbyStaleAfterSeconds } from "./config.js";
import { isSupportedLatLng, outOfCoverageMessage, recordOutOfCoverageRequest } from "./coverage.js";

const FIXED_CATEGORIES = ["restaurants", "bars", "attractions", "shops"];
const MAX_LLM_CANDIDATES = 40;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireAdminToken(request, env) {
  const expected = typeof env?.ADMIN_TOKEN === "string" ? env.ADMIN_TOKEN.trim() : "";
  if (expected.length === 0) {
    return {
      ok: false,
      response: errorResponse("Admin is disabled (set non-empty ADMIN_TOKEN in Worker environment variables).", 404),
    };
  }
  const provided = (request.headers.get("x-admin-token") ?? "").trim();
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
  if (parts.length === 3 && parts[0] === "candidates_latest") {
    const cell_id = parts[1] ?? "";
    const radius_bucket = Number.parseInt(parts[2] ?? "", 10);
    if (!cell_id) return null;
    if (!Number.isInteger(radius_bucket)) return null;
    return { kind: "candidates_latest", cell_id, radius_bucket };
  }
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

async function getBestCandidateSource(env, query, { radius_bucket, cell_id }) {
  return await findBestCandidates(env, query, { cell_id, radius_bucket });
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
      #map { height: 100%; width: 100%; color-scheme: light; background: #fff; }
      #map img { filter: none !important; }
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
      .results { display: grid; gap: 8px; margin-top: 10px; }
      .results button { text-align: left; line-height: 1.25; }
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
	          <div class="label">Search</div>
	          <div class="row">
	            <input id="searchQuery" placeholder="Search a place or address…" />
	            <button id="searchGo" class="primary">Go</button>
	          </div>
	          <div id="searchResults" class="results"></div>
	        </div>

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
            Overlay shows grouped cache (<span class="mono">nearby_latest</span>) as filled cells, and ingested candidates (<span class="mono">candidates_latest</span>) as outlines.
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
              Priming uses ingested candidates (from iOS taps) when available (no invented places).
              If a cell has no candidates yet, paste candidates JSON below or tap it in the iOS app once.
            </div>
            <textarea id="candidates" placeholder='Optional: paste candidates array JSON (max 40)...'></textarea>
            <button id="primeWithCandidates" class="danger" disabled>Prime with pasted candidates</button>
          </div>
        </div>

        <div class="card">
          <div class="label">Auto Prime</div>
          <div class="grid">
            <div class="row">
              <input id="autoHours" type="number" min="0.25" step="0.25" value="2" placeholder="Hours" />
              <input id="autoMaxCells" type="number" min="10" step="10" value="400" placeholder="Max cells" />
            </div>
            <div class="row">
              <input id="autoRings" type="number" min="1" step="1" value="10" placeholder="Rings" />
              <select id="autoMode">
                <option value="miss_only" selected>Prime missing</option>
                <option value="stale_or_miss">Prime stale+missing</option>
              </select>
            </div>
            <div class="row">
              <button id="autoStart" class="primary" disabled>Start</button>
              <button id="autoStop" class="danger" disabled>Stop</button>
            </div>
            <div id="autoStatus" class="status muted small">Auto prime runs in your browser session.</div>
          </div>
        </div>

        <div class="card">
          <div class="label">Notes</div>
          <div class="status">
            <div>API endpoints used:</div>
            <div class="mono">GET /admin/api/cached_cells</div>
            <div class="mono">GET /admin/api/candidate_cells</div>
            <div class="mono">GET /admin/api/cell_status</div>
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
        const adminEnabled = window.__adminEnabled !== false;
        const hasToken = (sessionStorage.getItem("aimap_admin_token") || "").trim().length > 0;
        const hasSelection = !!window.__selected;
        const isAutoRunning = !!(window.__auto && window.__auto.running);
        document.getElementById("prime").disabled = !adminEnabled || !hasToken || !hasSelection || isAutoRunning;
        document.getElementById("primeWithCandidates").disabled = !adminEnabled || !hasToken || !hasSelection || isAutoRunning;
        document.getElementById("autoStart").disabled = !adminEnabled || !hasToken || !hasSelection || isAutoRunning;
        document.getElementById("autoStop").disabled = !isAutoRunning;
      }

      function statusLine(text) {
        const el = document.getElementById("selected");
        if (el) el.textContent = text;
      }

      function autoStatus(text) {
        const el = document.getElementById("autoStatus");
        if (el) el.textContent = text;
      }

      async function loadAdminStatus() {
        try {
          const res = await fetch("/admin/api/admin_status");
          const data = await res.json();
          window.__adminEnabled = !!(data && data.admin_enabled);
          window.__hasKV = !!(data && data.has_kv);
          if (window.__adminEnabled === false) {
            statusLine("Admin is disabled on this Worker (set ADMIN_TOKEN).");
          } else if (window.__hasKV === false) {
            statusLine("KV binding MAP_CACHE is missing (cache will be ephemeral).");
          }
        } catch {
          // ignore
        }
      }

      window.__auto = { running: false };

      const COVERAGE_REGIONS = [
        { id: "singapore", title: "Singapore", bounds: { minLat: 1.13, maxLat: 1.48, minLng: 103.6, maxLng: 104.11 } },
        { id: "ho_chi_minh_city", title: "Ho Chi Minh City", bounds: { minLat: 10.35, maxLat: 11.2, minLng: 106.3, maxLng: 107.15 } },
      ];

      function inBounds(bounds, lat, lng) {
        return lat >= bounds.minLat && lat <= bounds.maxLat && lng >= bounds.minLng && lng <= bounds.maxLng;
      }

      function supportedRegion(lat, lng) {
        return COVERAGE_REGIONS.find((r) => inBounds(r.bounds, lat, lng)) || null;
      }

      function outOfCoverageMessage() {
        const names = COVERAGE_REGIONS.map((r) => r.title).join(" and ");
        return "AIMap will be available soon in your area. Currently supported: " + names + ".";
      }

      async function reportOutOfCoverage(lat, lng, source) {
        try {
          await fetch("/v1/map/coverage/report", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ lat, lng, source: source || "admin" })
          });
        } catch {
          // ignore
        }
      }

      const DEFAULT_CENTER = { lat: 1.3521, lng: 103.8198 };
      const map = L.map("map", { zoomControl: true }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 12);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
      }).addTo(map);

      const overlayLayer = L.layerGroup().addTo(map);
      const selectionLayer = L.layerGroup().addTo(map);

      function setSelected({ lat, lng, label }) {
        selectionLayer.clearLayers();
        const region = supportedRegion(lat, lng);
        const markerColor = region ? "#D84A4A" : "#8A8A8A";
        const marker = L.circleMarker([lat, lng], { radius: 6, color: markerColor, weight: 2, fillOpacity: 0.25 });
        marker.addTo(selectionLayer);

        if (!region) {
          window.__selected = null;
          statusLine(outOfCoverageMessage());
          reportOutOfCoverage(lat, lng, "admin_select");
          updateButtons();
          return;
        }

        const radiusBucket = parseInt(document.getElementById("radius").value, 10);
        const precision = precisionForRadiusBucket(radiusBucket);
        const cellId = geohashEncode(lat, lng, precision);
        window.__selected = { lat, lng, cell_id: cellId };
        const suffix =
          typeof label === "string" && label.trim().length > 0 ? " • " + label.trim() : "";
        statusLine(
          "Selected: " + lat.toFixed(6) + ", " + lng.toFixed(6) + " • cell " + cellId + suffix,
        );
        updateButtons();
      }

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
        let groupedAll = [];
        let candidatesAll = [];
        for (const prefix of prefixes) {
          const groupedUrl = \`/admin/api/cached_cells?cell_prefix=\${encodeURIComponent(prefix)}&radius_bucket=\${radiusBucket}&categories_key=\${encodeURIComponent(categoriesKey)}&limit=400\`;
          const candidatesUrl = \`/admin/api/candidate_cells?cell_prefix=\${encodeURIComponent(prefix)}&radius_bucket=\${radiusBucket}&limit=400\`;
          const groupedData = await fetchJson(groupedUrl, { headers: adminHeaders() });
          const candidatesData = await fetchJson(candidatesUrl, { headers: adminHeaders() });
          groupedAll = groupedAll.concat(groupedData.cells || []);
          candidatesAll = candidatesAll.concat(candidatesData.cells || []);
        }

        const uniqueCandidates = new Map();
        for (const cell of candidatesAll) {
          const key = cell.cell_id + ":" + cell.radius_bucket;
          const existing = uniqueCandidates.get(key);
          if (!existing || (cell.produced_at || 0) > (existing.produced_at || 0)) uniqueCandidates.set(key, cell);
        }

        for (const cell of uniqueCandidates.values()) {
          if (!cell.bounds) continue;
          const b = cell.bounds;
          const rect = L.rectangle([[b.lat_min, b.lng_min], [b.lat_max, b.lng_max]], {
            color: "#60A5FA",
            weight: 1,
            opacity: 0.55,
            fillOpacity: 0.0,
            dashArray: "5,6"
          });
          rect.bindTooltip(\`candidates \${cell.cell_id} • \${formatTs(cell.produced_at)}\`, { sticky: true });
          rect.addTo(overlayLayer);
        }

        const uniqueGrouped = new Map();
        for (const cell of groupedAll) {
          const key = cell.cell_id + ":" + cell.radius_bucket + ":" + cell.categories_key;
          const existing = uniqueGrouped.get(key);
          if (!existing || (cell.produced_at || 0) > (existing.produced_at || 0)) uniqueGrouped.set(key, cell);
        }

        for (const cell of uniqueGrouped.values()) {
          if (!cell.bounds) continue;
          const b = cell.bounds;
          const rect = L.rectangle([[b.lat_min, b.lng_min], [b.lat_max, b.lng_max]], {
            color: cell.stale ? "#F7C74A" : "#4CD964",
            weight: 1,
            opacity: 0.65,
            fillOpacity: cell.stale ? 0.08 : 0.10
          });
          rect.bindTooltip(\`grouped \${cell.cell_id} • \${cell.stale ? "stale" : "fresh"} • \${formatTs(cell.produced_at)}\`, { sticky: true });
          rect.addTo(overlayLayer);
        }
      }

      document.getElementById("refresh").addEventListener("click", () => refreshOverlay().catch(err => statusLine("Overlay error: " + err.message)));
      document.getElementById("radius").addEventListener("change", () => refreshOverlay().catch(err => statusLine("Overlay error: " + err.message)));
      map.on("moveend", () => refreshOverlay().catch(() => {}));

      map.on("click", (e) => {
        setSelected({ lat: e.latlng.lat, lng: e.latlng.lng });
      });

      async function searchNominatim(query) {
        const url =
          "https://nominatim.openstreetmap.org/search?format=json&limit=8&countrycodes=sg,vn&q=" + encodeURIComponent(query);
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error("Search failed (HTTP " + res.status + ")");
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      }

      function renderSearchResults(items) {
        const container = document.getElementById("searchResults");
        if (!container) return;
        container.innerHTML = "";

        const results = Array.isArray(items) ? items : [];
        if (results.length === 0) {
          const empty = document.createElement("div");
          empty.className = "status muted small";
          empty.textContent = "No results.";
          container.appendChild(empty);
          return;
        }

        for (const item of results.slice(0, 6)) {
          const lat = Number.parseFloat(item?.lat);
          const lng = Number.parseFloat(item?.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

          const label =
            typeof item?.display_name === "string" ? item.display_name : lat.toFixed(5) + ", " + lng.toFixed(5);
          const shortLabel = label.split(",").slice(0, 3).join(",").trim();

          const btn = document.createElement("button");
          btn.className = "primary";
          btn.textContent = shortLabel;
          btn.addEventListener("click", () => {
            const zoom = Math.max(13, map.getZoom());
            map.flyTo([lat, lng], zoom, { duration: 0.6 });
            setSelected({ lat, lng, label: shortLabel });
          });
          container.appendChild(btn);
        }
      }

      async function performSearch() {
        const query = (document.getElementById("searchQuery")?.value || "").trim();
        if (!query || query.length < 2) {
          renderSearchResults([]);
          return;
        }

        const container = document.getElementById("searchResults");
        if (container) {
          container.innerHTML = "";
          const msg = document.createElement("div");
          msg.className = "status muted small";
          msg.textContent = "Searching…";
          container.appendChild(msg);
        }

        const items = await searchNominatim(query);
        renderSearchResults(items);
      }

      document.getElementById("searchGo").addEventListener("click", () => {
        performSearch().catch((err) => statusLine("Search error: " + (err?.message ?? String(err))));
      });
      let __searchDebounce = null;
      document.getElementById("searchQuery").addEventListener("input", () => {
        if (__searchDebounce) clearTimeout(__searchDebounce);
        __searchDebounce = setTimeout(() => {
          performSearch().catch(() => {});
        }, 260);
      });
      document.getElementById("searchQuery").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          performSearch().catch((err) => statusLine("Search error: " + (err?.message ?? String(err))));
        }
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
          cell_id: window.__selected.cell_id,
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

      function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

      function stepMetersForBucket(bucket) {
        if (bucket === 300) return 220;
        if (bucket === 800) return 550;
        return 950;
      }

      function buildGridCells(center, rings, precision, stepMeters) {
        const latStep = stepMeters / 111000;
        const lngStep = stepMeters / (111000 * Math.max(0.2, Math.cos(center.lat * Math.PI / 180)));
        const byCell = new Map();

        for (let dy = -rings; dy <= rings; dy++) {
          for (let dx = -rings; dx <= rings; dx++) {
            const lat = center.lat + (dy * latStep);
            const lng = center.lng + (dx * lngStep);
            const cell = geohashEncode(lat, lng, precision);
            const dist2 = dx * dx + dy * dy;
            const existing = byCell.get(cell);
            if (!existing || dist2 < existing.dist2) {
              byCell.set(cell, { cell_id: cell, lat, lng, dist2 });
            }
          }
        }

        return Array.from(byCell.values()).sort((a, b) => a.dist2 - b.dist2);
      }

      function stopAutoPrime(message) {
        if (!window.__auto || !window.__auto.running) return;
        window.__auto.running = false;
        const s = window.__auto.stats;
        autoStatus(\`\${message} • primed=\${s.primed} • skipped=\${s.skipped} • errors=\${s.errors}\`);
        updateButtons();
        refreshOverlay().catch(() => {});
      }

      async function startAutoPrime() {
        const token = (sessionStorage.getItem("aimap_admin_token") || "").trim();
        if (!token) throw new Error("Set ADMIN_TOKEN first.");
        if (!window.__selected) throw new Error("Select a cell first.");
        if (window.__auto && window.__auto.running) return;

        const hours = Math.max(0.25, parseFloat(document.getElementById("autoHours").value || "2"));
        const maxCells = Math.max(10, parseInt(document.getElementById("autoMaxCells").value || "400", 10));
        const rings = Math.max(1, parseInt(document.getElementById("autoRings").value || "10", 10));
        const mode = document.getElementById("autoMode").value || "miss_only";

        const radiusBucket = parseInt(document.getElementById("radius").value, 10);
        const precision = precisionForRadiusBucket(radiusBucket);
        const stepMeters = stepMetersForBucket(radiusBucket);

        const cells = buildGridCells(window.__selected, rings, precision, stepMeters);
        const endAt = Date.now() + (hours * 60 * 60 * 1000);

        window.__auto = {
          running: true,
          endAt,
          radiusBucket,
          categoriesKey: categoriesKeyFixed(),
          mode,
          cells,
          index: 0,
          maxCells,
          stats: { primed: 0, skipped: 0, errors: 0 }
        };

        autoStatus(\`Auto prime started • cells=\${cells.length} • hours=\${hours}\`);
        updateButtons();

        while (window.__auto.running) {
          const auto = window.__auto;
          if (Date.now() >= auto.endAt) {
            stopAutoPrime("Auto prime finished (time elapsed)");
            break;
          }
          if (auto.index >= auto.cells.length || auto.index >= auto.maxCells) {
            stopAutoPrime("Auto prime finished (queue complete)");
            break;
          }

          const item = auto.cells[auto.index++];

          try {
            const statusUrl = \`/admin/api/cell_status?cell_id=\${encodeURIComponent(item.cell_id)}&radius_bucket=\${auto.radiusBucket}&categories_key=\${encodeURIComponent(auto.categoriesKey)}\`;
            const status = await fetchJson(statusUrl, { headers: adminHeaders() });
            const shouldPrime = auto.mode === "stale_or_miss"
              ? (!status.has_grouped || status.grouped_stale)
              : (!status.has_grouped);

            if (!shouldPrime) {
              auto.stats.skipped += 1;
            } else if (!status.has_candidates) {
              auto.stats.skipped += 1;
            } else {
              autoStatus(\`Priming \${item.cell_id}… (primed=\${auto.stats.primed})\`);
              await fetchJson("/admin/api/prime", {
                method: "POST",
                headers: { "content-type": "application/json", ...adminHeaders() },
                body: JSON.stringify({
                  lat: item.lat,
                  lng: item.lng,
                  radius_m: auto.radiusBucket,
                  cell_id: item.cell_id,
                  categories: ["restaurants","bars","attractions","shops"],
                  allow_approx_candidates: false
                })
              });
              auto.stats.primed += 1;
            }
          } catch (err) {
            window.__auto.stats.errors += 1;
          }

          const remaining = Math.min(window.__auto.cells.length, window.__auto.maxCells) - window.__auto.index;
          autoStatus(\`Running • primed=\${window.__auto.stats.primed} • skipped=\${window.__auto.stats.skipped} • errors=\${window.__auto.stats.errors} • remaining=\${Math.max(0, remaining)}\`);

          if ((window.__auto.stats.primed + window.__auto.stats.skipped) % 12 === 0) {
            refreshOverlay().catch(() => {});
          }

          await sleep(300);
        }
      }

      document.getElementById("autoStart").addEventListener("click", () => startAutoPrime().catch(err => autoStatus("Auto prime error: " + err.message)));
      document.getElementById("autoStop").addEventListener("click", () => stopAutoPrime("Auto prime stopped"));

      loadAdminStatus().finally(() => updateButtons());
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

  if (url.pathname === "/admin/api/admin_status" && request.method === "GET") {
    const enabled = typeof env?.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.trim().length > 0;
    const hasKV = env?.MAP_CACHE && typeof env.MAP_CACHE.get === "function" && typeof env.MAP_CACHE.put === "function";
    return jsonResponse({ admin_enabled: enabled, has_kv: !!hasKV });
  }

  if (url.pathname === "/admin/api/candidate_cells" && request.method === "GET") {
    const auth = requireAdminToken(request, env);
    if (!auth.ok) return auth.response;

    const cellPrefix = url.searchParams.get("cell_prefix") ?? "";
    const radiusBucketParam = Number.parseInt(url.searchParams.get("radius_bucket") ?? "", 10);
    const radiusBucketFilter = Number.isInteger(radiusBucketParam) ? radiusBucketParam : null;
    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isInteger(limitParam) ? Math.min(800, Math.max(1, limitParam)) : 200;

    const listPrefix = `candidates_latest:${cellPrefix}`;
    const listed = await kvList(env, { prefix: listPrefix, limit });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const staleAfterSeconds = nearbyStaleAfterSeconds(env);

    const keys = Array.isArray(listed?.keys) ? listed.keys : [];
    const entries = keys
      .map((k) => parseCachedKeyName(k?.name))
      .filter((parsed) => parsed?.kind === "candidates_latest")
      .filter((parsed) => (radiusBucketFilter ? parsed.radius_bucket === radiusBucketFilter : true));

    const cells = [];
    for (const entry of entries) {
      const key = candidatesLatestKey(entry);
      const cached = await kvGetJson(env, key);
      if (!cached || !isObject(cached)) continue;
      const produced_at = typeof cached.produced_at === "number" ? cached.produced_at : 0;
      const etag = typeof cached.etag === "string" ? cached.etag : null;
      const bounds = geohashDecodeBounds(entry.cell_id);
      if (!bounds) continue;
      const stale = produced_at > 0 ? nowSeconds - produced_at > staleAfterSeconds : true;
      const count = Array.isArray(cached.candidates) ? cached.candidates.length : 0;

      cells.push({
        cell_id: entry.cell_id,
        radius_bucket: entry.radius_bucket,
        produced_at,
        stale,
        etag,
        count,
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

  if (url.pathname === "/admin/api/cell_status" && request.method === "GET") {
    const auth = requireAdminToken(request, env);
    if (!auth.ok) return auth.response;

    const cell_id = url.searchParams.get("cell_id") ?? "";
    const radiusBucketParam = Number.parseInt(url.searchParams.get("radius_bucket") ?? "", 10);
    const categories_key = url.searchParams.get("categories_key") ?? "";
    if (!cell_id) return errorResponse("Invalid cell_id", 400);
    if (!Number.isInteger(radiusBucketParam)) return errorResponse("Invalid radius_bucket", 400);
    if (!categories_key) return errorResponse("Invalid categories_key", 400);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const staleAfterSeconds = nearbyStaleAfterSeconds(env);

    const groupedKey = nearbyLatestKey({ cell_id, radius_bucket: radiusBucketParam, categories_key });
    const grouped = await kvGetJson(env, groupedKey);
    const groupedProducedAt = typeof grouped?.produced_at === "number" ? grouped.produced_at : 0;
    const has_grouped = !!grouped && typeof grouped?.etag === "string" && isObject(grouped?.payload);
    const grouped_stale = groupedProducedAt > 0 ? nowSeconds - groupedProducedAt > staleAfterSeconds : true;

    const candidatesKey = candidatesLatestKey({ cell_id, radius_bucket: radiusBucketParam });
    const candidates = await kvGetJson(env, candidatesKey);
    const candidatesProducedAt = typeof candidates?.produced_at === "number" ? candidates.produced_at : 0;
    const has_candidates = !!candidates && typeof candidates?.etag === "string" && Array.isArray(candidates?.candidates);
    const candidates_stale = candidatesProducedAt > 0 ? nowSeconds - candidatesProducedAt > staleAfterSeconds : true;

    const center = geohashCenter(cell_id);

    return jsonResponse({
      cell_id,
      radius_bucket: radiusBucketParam,
      categories_key,
      center,
      has_grouped,
      grouped_produced_at: groupedProducedAt || null,
      grouped_stale,
      has_candidates,
      candidates_produced_at: candidatesProducedAt || null,
      candidates_stale,
    });
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
    const staleAfterSeconds = nearbyStaleAfterSeconds(env);

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
      const stale = produced_at > 0 ? nowSeconds - produced_at > staleAfterSeconds : true;

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
    if (!isSupportedLatLng(lat, lng)) {
      await recordOutOfCoverageRequest(env, { lat, lng, source: "admin_prime" });
      return errorResponse(outOfCoverageMessage(), 403, { code: "OUT_OF_COVERAGE" });
    }
    if (typeof radius_m !== "number" || !Number.isInteger(radius_m) || radius_m <= 0) return errorResponse("Invalid radius_m", 400);

    const categories = Array.isArray(bodyUnknown.categories) ? bodyUnknown.categories : FIXED_CATEGORIES;
    const categories_key = categoriesKey(categories);
    const bucket = radiusBucket(radius_m);
    const precision = geohashPrecisionForRadiusBucket(bucket);
    const cell_id = typeof bodyUnknown.cell_id === "string" && bodyUnknown.cell_id.length > 0 ? bodyUnknown.cell_id : geohashEncode(lat, lng, precision);
    const allowApprox = bodyUnknown.allow_approx_candidates !== false;
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

      try {
        await ingestCandidates(env, {
          lat,
          lng,
          cell_id,
          radius_bucket: bucket,
          candidates,
          nowSeconds: Math.floor(Date.now() / 1000),
          ttlSeconds: candidatesCacheTtlSeconds(env),
        });
      } catch (err) {
        safeLog(env, "[admin prime] candidates_ingest_failed", { err: String(err) });
      }
    } else {
      const best = await getBestCandidateSource(env, { lat, lng }, { radius_bucket: bucket, cell_id });
      if (!best) {
        return errorResponse(
          "No cached candidates found for this area. Tap it in the iOS app once or paste candidates JSON.",
          404,
        );
      }
      candidates = best.candidates;
      if (best.cell_id !== cell_id) {
        if (!allowApprox) {
          return errorResponse("No exact candidates for this cell (ingest first).", 404);
        }
        candidateSource = {
          accuracy: "approx",
          source_cell_id: best.cell_id,
          source_distance_m: typeof best.source_distance_m === "number" ? best.source_distance_m : null,
        };
      }
    }

    safeLog(env, "[admin prime] request", {
      cell_id,
      radius_bucket: bucket,
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

    const latestKey = nearbyLatestKey({ cell_id, radius_bucket: bucket, categories_key });
    await kvPutJson(env, latestKey, cacheValue, nearbyCacheTtlSeconds(env));

    return jsonResponse({ status: "ok", cell_id, etag });
  }

  return errorResponse("Not found", 404);
}

import { jsonResponse, errorResponse } from "./utils.js";
import { crawlOnePoiWebsite } from "./poiImageCrawl.js";
import {
  countCandidatesByStatus,
  listPoiWebsiteStatus,
  listPoiWebsitesForCrawlBatch,
  markPoiWebsiteCrawled,
  upsertPoiWebsite,
} from "./poiImageDb.js";
import { filterBatch, generateThumbBatch } from "./poiImagePipeline.js";

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

function adminHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AIMap · POI Images</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; background: #070A10; color: #E8E8E8; }
      header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); background: rgba(7,10,16,0.9); position: sticky; top: 0; }
      header h1 { font-size: 14px; letter-spacing: 0.14em; margin: 0; font-weight: 500; color: rgba(232,232,232,0.9); }
      main { padding: 16px; max-width: 980px; margin: 0 auto; }
      .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px; margin-bottom: 14px; }
      .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .row > * { flex: 1; min-width: 180px; }
      input, button, textarea { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); color: #E8E8E8; border-radius: 10px; padding: 10px 12px; font-size: 13px; outline: none; }
      input::placeholder, textarea::placeholder { color: rgba(232,232,232,0.5); }
      button { cursor: pointer; flex: 0 0 auto; min-width: 160px; }
      button.primary { background: rgba(212,194,140,0.14); border-color: rgba(212,194,140,0.35); }
      button.danger { background: rgba(214,84,84,0.14); border-color: rgba(214,84,84,0.35); }
      .label { font-size: 12px; color: rgba(232,232,232,0.7); margin-bottom: 8px; }
      pre { white-space: pre-wrap; word-break: break-word; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); padding: 10px; border-radius: 12px; font-size: 12px; }
      .muted { color: rgba(232,232,232,0.6); font-size: 12px; line-height: 1.5; }
      table { width: 100%; border-collapse: separate; border-spacing: 0; overflow: hidden; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; }
      th, td { padding: 10px 10px; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); vertical-align: top; }
      th { text-align: left; font-weight: 600; color: rgba(232,232,232,0.8); background: rgba(255,255,255,0.03); }
      tr:last-child td { border-bottom: 0; }
      .thumb { width: 96px; height: 64px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); object-fit: cover; display: block; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .nowrap { white-space: nowrap; }
      .link { color: rgba(212,194,140,0.92); text-decoration: none; }
    </style>
  </head>
  <body>
    <header>
      <h1>AI MAP · POI IMAGES</h1>
      <div class="row" style="max-width: 520px; margin: 0;">
        <input id="token" placeholder="ADMIN_TOKEN" />
        <button id="saveToken" class="primary">Save</button>
      </div>
    </header>
    <main>
      <div class="card">
        <div class="label">Status</div>
        <div class="row">
          <button id="refreshStatus" class="primary">Refresh status</button>
          <div class="muted" id="statusText">—</div>
        </div>
      </div>

      <div class="card">
        <div class="label">Website crawl status</div>
        <div class="row">
          <button id="refreshWebsites" class="primary">Refresh table</button>
          <div class="muted" id="websitesHint">Shows up to 50 websites.</div>
        </div>
        <div style="margin-top:10px; overflow:auto;">
          <table id="websitesTable">
            <thead>
              <tr>
                <th class="nowrap">Image</th>
                <th>POI</th>
                <th>Website</th>
                <th class="nowrap">Hits</th>
                <th class="nowrap">Last crawl</th>
                <th class="nowrap">Candidates</th>
                <th class="nowrap">Approved</th>
              </tr>
            </thead>
            <tbody id="websitesBody"></tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="label">Manual crawl (no LLM)</div>
        <div class="row">
          <input id="poiId" placeholder="poi_id (e.g. place_local_id)" />
          <input id="websiteUrl" placeholder="website_url (https://...)" />
          <button id="crawlOne" class="primary">Crawl one</button>
        </div>
        <div class="muted" style="margin-top:10px">Extracts up to 5 candidate image URLs (og:image, twitter:image, image_src, img src).</div>
      </div>

      <div class="card">
        <div class="label">Batch crawl (from cached POI websites)</div>
        <div class="row">
          <input id="crawlBatchLimit" type="number" min="1" max="100" value="15" />
          <button id="crawlBatch" class="primary">Crawl batch</button>
        </div>
        <div class="muted" style="margin-top:10px">Uses the seeded POI website cache (from app candidate ingestion). Prioritizes stale and higher-hit POIs.</div>
      </div>

      <div class="card">
        <div class="label">Thumb batch (no LLM)</div>
        <div class="row">
          <input id="thumbLimit" type="number" min="1" max="200" value="25" />
          <button id="thumbBatch" class="primary">Generate thumbs</button>
        </div>
        <div class="muted" style="margin-top:10px">Generates 256px-wide low-quality JPEG thumbs in R2 for NEW candidates.</div>
      </div>

      <div class="card">
        <div class="label">LLM filter batch (thumb-only)</div>
        <div class="row">
          <input id="filterLimit" type="number" min="1" max="100" value="10" />
          <button id="filterBatch" class="danger">Run LLM filter</button>
        </div>
        <div class="muted" style="margin-top:10px">LLM only sees the low-quality thumbnail. If SAFE, full image is fetched and stored.</div>
      </div>

      <div class="card">
        <div class="label">Output</div>
        <pre id="out">—</pre>
      </div>
    </main>

    <script>
      const storedToken = sessionStorage.getItem("aimap_admin_token") || "";
      const tokenEl = document.getElementById("token");
      tokenEl.value = storedToken;

      function token() {
        return (tokenEl.value || "").trim();
      }

      document.getElementById("saveToken").addEventListener("click", () => {
        sessionStorage.setItem("aimap_admin_token", token());
        document.getElementById("out").textContent = "Saved token to sessionStorage.";
      });

      async function api(path, body) {
        const res = await fetch(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": token(),
          },
          body: JSON.stringify(body || {}),
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        if (!res.ok) {
          const msg = data?.error?.message || ("HTTP " + res.status);
          throw new Error(msg + (data?.error?.details ? (": " + JSON.stringify(data.error.details)) : ""));
        }
        return data || text;
      }

      async function refreshStatus() {
        const res = await fetch("/admin/poiimage/status", {
          method: "GET",
          headers: { "x-admin-token": token() },
        });
        const data = await res.json();
        document.getElementById("statusText").textContent =
          "NEW=" + data.counts.NEW +
          " · THUMB_READY=" + data.counts.THUMB_READY +
          " · FILTERED=" + data.counts.FILTERED +
          " · DROPPED=" + data.counts.DROPPED;
      }

      function fmtTs(ms) {
        if (!ms) return "—";
        try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
      }

      function safeText(value) {
        return typeof value === "string" ? value : "";
      }

      function domainFromUrl(url) {
        try { return new URL(url).hostname; } catch { return url; }
      }

      async function refreshWebsites() {
        const res = await fetch("/admin/poiimage/websites?limit=50", {
          method: "GET",
          headers: { "x-admin-token": token() },
        });
        const data = await res.json();
        const rows = Array.isArray(data?.websites) ? data.websites : [];

        const body = document.getElementById("websitesBody");
        if (!body) return;
        body.innerHTML = "";

        for (const row of rows) {
          const tr = document.createElement("tr");

          const thumbTd = document.createElement("td");
          if (row.thumb_r2_key) {
            const img = document.createElement("img");
            img.className = "thumb";
            img.loading = "lazy";
            img.alt = "thumb";
            img.src = "/img/" + encodeURIComponent(row.thumb_r2_key);
            thumbTd.appendChild(img);
          } else {
            const empty = document.createElement("div");
            empty.className = "thumb";
            thumbTd.appendChild(empty);
          }
          tr.appendChild(thumbTd);

          const poiTd = document.createElement("td");
          const poiId = safeText(row.poi_id);
          poiTd.className = "mono";
          poiTd.textContent = poiId.length > 16 ? poiId.slice(0, 16) + "…" : poiId;
          tr.appendChild(poiTd);

          const siteTd = document.createElement("td");
          const siteUrl = safeText(row.website_url);
          const a = document.createElement("a");
          a.className = "link";
          a.href = siteUrl;
          a.target = "_blank";
          a.rel = "noreferrer";
          a.textContent = domainFromUrl(siteUrl);
          siteTd.appendChild(a);
          tr.appendChild(siteTd);

          const hitsTd = document.createElement("td");
          hitsTd.className = "nowrap";
          hitsTd.textContent = String(row.hit_count ?? 0);
          tr.appendChild(hitsTd);

          const crawlTd = document.createElement("td");
          crawlTd.className = "nowrap";
          crawlTd.textContent = row.last_crawled_at ? fmtTs(row.last_crawled_at) : (row.last_crawled_date || "—");
          tr.appendChild(crawlTd);

          const candTd = document.createElement("td");
          candTd.className = "nowrap";
          candTd.textContent = String(row.candidates_total ?? 0);
          tr.appendChild(candTd);

          const apprTd = document.createElement("td");
          apprTd.className = "nowrap";
          apprTd.textContent = String(row.approved_total ?? 0);
          tr.appendChild(apprTd);

          body.appendChild(tr);
        }

        const hint = document.getElementById("websitesHint");
        if (hint) hint.textContent = "Rows: " + rows.length;
      }

      document.getElementById("refreshStatus").addEventListener("click", () => refreshStatus().catch(err => {
        document.getElementById("out").textContent = "Status error: " + err.message;
      }));
      document.getElementById("refreshWebsites").addEventListener("click", () => refreshWebsites().catch(err => {
        document.getElementById("out").textContent = "Websites error: " + err.message;
      }));

      document.getElementById("crawlOne").addEventListener("click", async () => {
        try {
          const poi_id = document.getElementById("poiId").value.trim();
          const website_url = document.getElementById("websiteUrl").value.trim();
          const data = await api("/admin/poiimage/crawl_one", { poi_id, website_url });
          document.getElementById("out").textContent = JSON.stringify(data, null, 2);
          refreshStatus().catch(() => {});
          refreshWebsites().catch(() => {});
        } catch (err) {
          document.getElementById("out").textContent = "Crawl error: " + err.message;
        }
      });

      document.getElementById("crawlBatch").addEventListener("click", async () => {
        try {
          const limit = Number.parseInt(document.getElementById("crawlBatchLimit").value, 10);
          const data = await api("/admin/poiimage/crawl_batch", { limit });
          document.getElementById("out").textContent = JSON.stringify(data, null, 2);
          refreshStatus().catch(() => {});
          refreshWebsites().catch(() => {});
        } catch (err) {
          document.getElementById("out").textContent = "Batch crawl error: " + err.message;
        }
      });

      document.getElementById("thumbBatch").addEventListener("click", async () => {
        try {
          const limit = Number.parseInt(document.getElementById("thumbLimit").value, 10);
          const data = await api("/admin/poiimage/thumb_batch", { limit });
          document.getElementById("out").textContent = JSON.stringify(data, null, 2);
          refreshStatus().catch(() => {});
          refreshWebsites().catch(() => {});
        } catch (err) {
          document.getElementById("out").textContent = "Thumb batch error: " + err.message;
        }
      });

      document.getElementById("filterBatch").addEventListener("click", async () => {
        try {
          const limit = Number.parseInt(document.getElementById("filterLimit").value, 10);
          const data = await api("/admin/poiimage/filter_batch", { limit });
          document.getElementById("out").textContent = JSON.stringify(data, null, 2);
          refreshStatus().catch(() => {});
          refreshWebsites().catch(() => {});
        } catch (err) {
          document.getElementById("out").textContent = "Filter batch error: " + err.message;
        }
      });

      refreshStatus().catch(() => {});
      refreshWebsites().catch(() => {});
    </script>
  </body>
</html>`;
}

export async function maybeHandlePoiImageAdmin(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && (url.pathname === "/admin/poiimage" || url.pathname === "/admin/poiimage/")) {
    return new Response(adminHtml(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (url.pathname === "/admin/poiimage/status" && request.method === "GET") {
    const auth = requireAdminToken(request, env);
    if (!auth.ok) return auth.response;
    const counts = {
      NEW: await countCandidatesByStatus(env, { status: "NEW" }),
      THUMB_READY: await countCandidatesByStatus(env, { status: "THUMB_READY" }),
      FILTERED: await countCandidatesByStatus(env, { status: "FILTERED" }),
      DROPPED: await countCandidatesByStatus(env, { status: "DROPPED" }),
    };
    return jsonResponse({ counts });
  }

  if (url.pathname === "/admin/poiimage/websites" && request.method === "GET") {
    const auth = requireAdminToken(request, env);
    if (!auth.ok) return auth.response;
    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isInteger(limitParam) ? limitParam : 50;
    const websites = await listPoiWebsiteStatus(env, { limit });
    return jsonResponse({ websites });
  }

  if (url.pathname === "/admin/poiimage/crawl_one" && request.method === "POST") {
    const auth = requireAdminToken(request, env);
    if (!auth.ok) return auth.response;

    let bodyUnknown;
    try {
      bodyUnknown = await request.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }
    if (!isObject(bodyUnknown)) return errorResponse("Invalid request", 400);
    const poi_id = bodyUnknown.poi_id;
    const website_url = bodyUnknown.website_url;
    if (typeof poi_id !== "string" || poi_id.length === 0) return errorResponse("Invalid poi_id", 400);
    if (typeof website_url !== "string" || website_url.length === 0) return errorResponse("Invalid website_url", 400);

    await upsertPoiWebsite(env, { poi_id, website_url });
    const result = await crawlOnePoiWebsite(env, { poi_id, website_url, maxCandidates: 5 });
    return jsonResponse({ status: "ok", ...result });
  }

  if (url.pathname === "/admin/poiimage/crawl_batch" && request.method === "POST") {
    const auth = requireAdminToken(request, env);
    if (!auth.ok) return auth.response;

    let bodyUnknown;
    try {
      bodyUnknown = await request.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }
    const limit = isObject(bodyUnknown) ? bodyUnknown.limit : undefined;
    const parsedLimit = Number.isInteger(limit) ? limit : 15;

    const today = new Date().toISOString().slice(0, 10);
    const start = Date.now();
    const timeBudgetMs = 25_000;

    const selected = await listPoiWebsitesForCrawlBatch(env, { limit: parsedLimit });
    const results = [];
    for (const entry of selected) {
      const elapsed = Date.now() - start;
      if (elapsed > timeBudgetMs - 1200) break;
      try {
        const out = await crawlOnePoiWebsite(env, { poi_id: entry.poi_id, website_url: entry.website_url, maxCandidates: 5 });
        await markPoiWebsiteCrawled(env, { poi_id: entry.poi_id, date: today });
        results.push({ poi_id: entry.poi_id, website_url: entry.website_url, extracted: out.extracted, hit_count: entry.hit_count ?? 0 });
      } catch (err) {
        results.push({ poi_id: entry.poi_id, website_url: entry.website_url, error: String(err), hit_count: entry.hit_count ?? 0 });
      }
    }

    return jsonResponse({ status: "ok", requested: parsedLimit, selected: selected.length, processed: results.length, results });
  }

  if (url.pathname === "/admin/poiimage/thumb_batch" && request.method === "POST") {
    const auth = requireAdminToken(request, env);
    if (!auth.ok) return auth.response;

    let bodyUnknown;
    try {
      bodyUnknown = await request.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }
    const limit = isObject(bodyUnknown) ? bodyUnknown.limit : undefined;
    const parsedLimit = Number.isInteger(limit) ? limit : 25;
    const result = await generateThumbBatch(env, { limit: parsedLimit });
    return jsonResponse({ status: "ok", ...result });
  }

  if (url.pathname === "/admin/poiimage/filter_batch" && request.method === "POST") {
    const auth = requireAdminToken(request, env);
    if (!auth.ok) return auth.response;
    if (!env.OPENAI_API_KEY) return errorResponse("Missing OPENAI_API_KEY", 500);

    let bodyUnknown;
    try {
      bodyUnknown = await request.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }
    const limit = isObject(bodyUnknown) ? bodyUnknown.limit : undefined;
    const parsedLimit = Number.isInteger(limit) ? limit : 10;
    const result = await filterBatch(env, { limit: parsedLimit });
    return jsonResponse({ status: "ok", ...result });
  }

  return null;
}

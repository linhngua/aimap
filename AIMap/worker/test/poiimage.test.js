import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractCandidateImageUrlsFromHtml } from "../src/poiImageCrawl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readFixture(name) {
  const p = path.join(__dirname, "..", "fixtures", name);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("poiimage fixtures validate: crawl_one", () => {
  const req = readFixture("poiimage_crawl_one.request.json");
  const res = readFixture("poiimage_crawl_one.response.ok.json");
  assert.equal(typeof req.poi_id, "string");
  assert.ok(req.poi_id.length > 0);
  assert.equal(typeof req.website_url, "string");
  assert.ok(req.website_url.startsWith("http"));

  assert.equal(res.status, "ok");
  assert.equal(res.poi_id, req.poi_id);
  assert.equal(typeof res.website_url, "string");
  assert.equal(typeof res.extracted, "number");
  assert.ok(Array.isArray(res.candidates));
});

test("poiimage fixtures validate: thumb_batch", () => {
  const req = readFixture("poiimage_thumb_batch.request.json");
  const res = readFixture("poiimage_thumb_batch.response.ok.json");
  assert.equal(typeof req.limit, "number");
  assert.equal(res.status, "ok");
  assert.equal(typeof res.processed, "number");
  assert.ok(Array.isArray(res.results));
});

test("poiimage fixtures validate: filter_batch", () => {
  const req = readFixture("poiimage_filter_batch.request.json");
  const res = readFixture("poiimage_filter_batch.response.ok.json");
  assert.equal(typeof req.limit, "number");
  assert.equal(res.status, "ok");
  assert.equal(typeof res.processed, "number");
  assert.ok(Array.isArray(res.results));
});

test("poiimage fixtures validate: api images response", () => {
  const res = readFixture("poiimage_api_images.response.ok.json");
  assert.equal(typeof res.poi_id, "string");
  assert.ok(Array.isArray(res.images));
  for (const img of res.images) {
    assert.equal(img.poi_id, res.poi_id);
    assert.equal(typeof img.thumb_url, "string");
    assert.equal(typeof img.full_url, "string");
  }
});

test("extractCandidateImageUrlsFromHtml extracts + normalizes + filters", () => {
  const html = `
    <html>
      <head>
        <meta content="/og.jpg" property="og:image" />
        <meta name="twitter:image" content="https://cdn.example.com/tw.jpg" />
        <link href="//example.com/rel.jpg" rel="image_src" />
      </head>
      <body>
        <img src="/logo.png" />
        <img src="/hero.jpg" />
      </body>
    </html>`;

  const urls = extractCandidateImageUrlsFromHtml(html, "https://example.com/page");
  assert.ok(urls.includes("https://example.com/og.jpg"));
  assert.ok(urls.includes("https://cdn.example.com/tw.jpg"));
  assert.ok(urls.includes("https://example.com/rel.jpg"));
  assert.ok(urls.includes("https://example.com/hero.jpg"));
  assert.ok(!urls.some((u) => u.includes("logo.png")));
});


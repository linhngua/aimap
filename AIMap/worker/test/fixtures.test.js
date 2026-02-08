import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NearbyRequestSchema,
  NearbyResponseSchema,
  PlaceDetailRequestSchema,
  PlaceDetailResponseSchema,
} from "../src/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readFixture(name) {
  const p = path.join(__dirname, "..", "fixtures", name);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("fixtures validate: nearby", () => {
  const req = readFixture("nearby_request.json");
  const res = readFixture("nearby_response.json");
  assert.ok(NearbyRequestSchema.safeParse(req).success);
  assert.ok(NearbyResponseSchema.safeParse(res).success);
});

test("fixtures validate: place", () => {
  const req = readFixture("place_request.json");
  const res = readFixture("place_response.json");
  assert.ok(PlaceDetailRequestSchema.safeParse(req).success);
  assert.ok(PlaceDetailResponseSchema.safeParse(res).success);
});

test("fixtures validate: nearby_cached envelope", () => {
  const req = readFixture("nearby_cached_request.json");
  const res = readFixture("nearby_cached_response.json");
  assert.equal(typeof req.lat, "number");
  assert.equal(typeof req.lng, "number");
  assert.ok(Array.isArray(req.categories));
  assert.equal(typeof req.cell_id, "string");
  assert.equal(typeof req.time_bucket, "string");

  assert.equal(typeof res.hit, "boolean");
  assert.equal(typeof res.stale, "boolean");
  assert.ok(["exact", "approx", "miss"].includes(res.accuracy));
});

test("fixtures validate: nearby_refresh envelope", () => {
  const req = readFixture("nearby_refresh_request.json");
  const res = readFixture("nearby_refresh_response.json");
  assert.ok(Array.isArray(req.candidates));
  assert.ok(["ok", "unchanged"].includes(res.status));
  assert.equal(typeof res.etag, "string");
});

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


import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizeNearbyResponse, sanitizePlaceDetailResponse } from "../src/sanitize.js";
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

test("sanitizeNearbyResponse tolerates extra keys + filters unknown ids", () => {
  const req = NearbyRequestSchema.parse(readFixture("nearby_request.json"));

  const raw = {
    name: "extra-top-level-field",
    restaurants: [
      {
        place_local_id: req.candidates[0].place_local_id,
        score: "0.9",
        why: "Great nearby option.",
        tags: ["test"],
        best_for: "quick bite",
        cautions: [],
        name: "extra-item-field",
      },
      {
        place_local_id: "hallucinated_id",
        score: 0.5,
        why: "Should be filtered out.",
        tags: [],
        best_for: "",
        cautions: [],
      },
    ],
    bars: [],
    attractions: [],
    shops: [],
  };

  const { response, meta } = sanitizeNearbyResponse(raw, req);
  assert.ok(NearbyResponseSchema.safeParse(response).success);
  assert.equal(meta.dropped_unknown_candidate_ids, 1);
  assert.equal(response.categories.restaurants.length, 1);
  assert.equal(response.categories.restaurants[0].place_local_id, req.candidates[0].place_local_id);
});

test("sanitizeNearbyResponse uses fallback when output empty", () => {
  const req = NearbyRequestSchema.parse(readFixture("nearby_request.json"));
  const { response, meta } = sanitizeNearbyResponse(null, req);
  assert.ok(NearbyResponseSchema.safeParse(response).success);
  assert.equal(meta.used_fallback, true);
  const total = Object.values(response.categories).reduce((acc, items) => acc + items.length, 0);
  assert.equal(total, req.candidates.length);
});

test("sanitizePlaceDetailResponse strips extra keys + enforces inference safety", () => {
  const req = PlaceDetailRequestSchema.parse(readFixture("place_request.json"));

  const raw = {
    name: "extra-top-level-field",
    place_local_id: "WRONG",
    mode: "signals",
    headline: "People say it's amazing.",
    why_worth_it: "Must-try cocktails.",
    nearby_moves: [
      { place_local_id: "hallucinated_id", label: "Fake", reason: "Should be filtered." },
    ],
    practical: ["Do a thing."],
    area_fun_fact: [{ fact: "Made up.", source: "None" }],
    confidence: "high",
    disclosure: "",
  };

  const { response, meta } = sanitizePlaceDetailResponse(raw, req);
  assert.ok(PlaceDetailResponseSchema.safeParse(response).success);
  assert.equal(response.place_local_id, req.place.place_local_id);
  assert.equal(response.mode, "inference");
  assert.equal(meta.used_fallback, true);
  assert.ok(!response.headline.toLowerCase().includes("people say"));
  assert.ok(!response.why_worth_it.toLowerCase().includes("must-try"));
});

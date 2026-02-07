function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${field}`);
  }
}

function validateNumber(value, field) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Invalid ${field}`);
  }
}

function validateBooleanOrNull(value, field) {
  if (value === null || value === undefined) return;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${field}`);
  }
}

function validateNullableString(value, field) {
  if (value === null || value === undefined) return;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}`);
  }
}

function validateNullableNumber(value, field) {
  if (value === null || value === undefined) return;
  validateNumber(value, field);
}

function validateArray(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${field}`);
  }
}

function validateStrictKeys(obj, allowedKeys, field) {
  const keys = Object.keys(obj);
  for (const key of keys) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Unexpected field ${field}.${key}`);
    }
  }
}

export const NearbyRequestSchema = {
  parse(input) {
    if (!isObject(input)) throw new Error("Invalid request");
    validateStrictKeys(input, ["lat", "lng", "radius_m", "candidates", "user_context"], "request");
    validateNumber(input.lat, "lat");
    validateNumber(input.lng, "lng");
    if (typeof input.radius_m !== "number" || !Number.isInteger(input.radius_m) || input.radius_m <= 0) {
      throw new Error("Invalid radius_m");
    }
    validateArray(input.candidates, "candidates");
    if (input.candidates.length > 40) throw new Error("Too many candidates");
    const candidates = input.candidates.map((c) => PlaceCandidateSchema.parse(c));
    let userContext = undefined;
    if (input.user_context !== undefined) {
      userContext = UserContextSchema.parse(input.user_context);
    }
    return {
      lat: input.lat,
      lng: input.lng,
      radius_m: input.radius_m,
      candidates,
      user_context: userContext,
    };
  },
  safeParse(input) {
    try {
      return { success: true, data: this.parse(input) };
    } catch (error) {
      return { success: false, error };
    }
  },
};

export const PlaceCandidateSchema = {
  parse(input) {
    if (!isObject(input)) throw new Error("Invalid candidate");
    validateStrictKeys(
      input,
      [
        "place_local_id",
        "name",
        "lat",
        "lng",
        "address_short",
        "raw_categories",
        "url",
        "phone",
        "rating",
        "rating_count",
        "price_level",
        "open_now",
      ],
      "candidate",
    );
    validateString(input.place_local_id, "place_local_id");
    validateString(input.name, "name");
    validateNumber(input.lat, "lat");
    validateNumber(input.lng, "lng");
    if (input.address_short !== undefined && typeof input.address_short !== "string") {
      throw new Error("Invalid address_short");
    }
    const address_short = typeof input.address_short === "string" ? input.address_short : "";
    const raw_categories = Array.isArray(input.raw_categories)
      ? input.raw_categories.filter((x) => typeof x === "string")
      : [];
    validateNullableString(input.url, "url");
    validateNullableString(input.phone, "phone");
    validateNullableNumber(input.rating, "rating");
    if (input.rating_count !== null && input.rating_count !== undefined) {
      if (typeof input.rating_count !== "number" || !Number.isInteger(input.rating_count)) {
        throw new Error("Invalid rating_count");
      }
    }
    if (input.price_level !== null && input.price_level !== undefined) {
      if (typeof input.price_level !== "number" || !Number.isInteger(input.price_level)) {
        throw new Error("Invalid price_level");
      }
    }
    validateBooleanOrNull(input.open_now, "open_now");

    return {
      place_local_id: input.place_local_id,
      name: input.name,
      lat: input.lat,
      lng: input.lng,
      address_short,
      raw_categories,
      url: input.url ?? null,
      phone: input.phone ?? null,
      rating: input.rating ?? null,
      rating_count: input.rating_count ?? null,
      price_level: input.price_level ?? null,
      open_now: input.open_now ?? null,
    };
  },
  safeParse(input) {
    try {
      return { success: true, data: this.parse(input) };
    } catch (error) {
      return { success: false, error };
    }
  },
};

const UserContextSchema = {
  parse(input) {
    if (!isObject(input)) throw new Error("Invalid user_context");
    validateStrictKeys(input, ["time_of_day", "vibe", "budget"], "user_context");
    if (input.time_of_day !== undefined) validateNullableString(input.time_of_day, "time_of_day");
    if (input.vibe !== undefined) validateNullableString(input.vibe, "vibe");
    if (input.budget !== undefined) validateNullableString(input.budget, "budget");
    return {
      time_of_day: input.time_of_day,
      vibe: input.vibe,
      budget: input.budget,
    };
  },
};

export const NearbyResponseSchema = {
  parse(input) {
    if (!isObject(input)) throw new Error("Invalid response");
    validateStrictKeys(input, ["query", "categories"], "response");

    if (!isObject(input.query)) throw new Error("Invalid query");
    validateStrictKeys(input.query, ["lat", "lng", "radius_m"], "query");
    validateNumber(input.query.lat, "query.lat");
    validateNumber(input.query.lng, "query.lng");
    if (typeof input.query.radius_m !== "number" || !Number.isInteger(input.query.radius_m)) {
      throw new Error("Invalid query.radius_m");
    }

    if (!isObject(input.categories)) throw new Error("Invalid categories");
    validateStrictKeys(
      input.categories,
      ["restaurants", "bars", "attractions", "shops"],
      "categories",
    );

    return {
      query: {
        lat: input.query.lat,
        lng: input.query.lng,
        radius_m: input.query.radius_m,
      },
      categories: {
        restaurants: validateNearbyItems(input.categories.restaurants, "restaurants"),
        bars: validateNearbyItems(input.categories.bars, "bars"),
        attractions: validateNearbyItems(input.categories.attractions, "attractions"),
        shops: validateNearbyItems(input.categories.shops, "shops"),
      },
    };
  },
  safeParse(input) {
    try {
      return { success: true, data: this.parse(input) };
    } catch (error) {
      return { success: false, error };
    }
  },
};

function validateNearbyItems(value, field) {
  validateArray(value, field);
  return value.map((item) => NearbyItemSchema.parse(item));
}

export const NearbyItemSchema = {
  parse(input) {
    if (!isObject(input)) throw new Error("Invalid item");
    validateStrictKeys(input, ["place_local_id", "score", "why", "tags", "best_for", "cautions"], "item");
    validateString(input.place_local_id, "place_local_id");
    validateNumber(input.score, "score");
    if (typeof input.why !== "string") throw new Error("Invalid why");
    validateArray(input.tags, "tags");
    if (!input.tags.every((t) => typeof t === "string")) throw new Error("Invalid tags");
    if (typeof input.best_for !== "string") throw new Error("Invalid best_for");
    validateArray(input.cautions, "cautions");
    if (!input.cautions.every((t) => typeof t === "string")) throw new Error("Invalid cautions");

    return {
      place_local_id: input.place_local_id,
      score: input.score,
      why: input.why,
      tags: input.tags,
      best_for: input.best_for,
      cautions: input.cautions,
    };
  },
};

export const PlaceDetailRequestSchema = {
  parse(input) {
    if (!isObject(input)) throw new Error("Invalid request");
    validateStrictKeys(input, ["place", "review_snippets", "first_party_signals"], "request");
    const place = PlaceCandidateSchema.parse(input.place);

    const review_snippets = Array.isArray(input.review_snippets)
      ? input.review_snippets.map((s) => {
          if (!isObject(s)) throw new Error("Invalid review_snippet");
          validateStrictKeys(s, ["text"], "review_snippet");
          if (typeof s.text !== "string") throw new Error("Invalid review_snippet.text");
          return { text: s.text };
        })
      : [];

    const first_party_signals = isObject(input.first_party_signals)
      ? Object.fromEntries(
          Object.entries(input.first_party_signals).filter(([, v]) => typeof v === "string"),
        )
      : {};

    return { place, review_snippets, first_party_signals };
  },
  safeParse(input) {
    try {
      return { success: true, data: this.parse(input) };
    } catch (error) {
      return { success: false, error };
    }
  },
};

export const PlaceDetailResponseSchema = {
  parse(input) {
    if (!isObject(input)) throw new Error("Invalid response");
    validateStrictKeys(
      input,
      ["place_local_id", "mode", "summary", "highlights", "cautions", "tips", "disclosure"],
      "response",
    );
    validateString(input.place_local_id, "place_local_id");
    if (!["signals", "inference", "first_party"].includes(input.mode)) {
      throw new Error("Invalid mode");
    }
    if (typeof input.summary !== "string") throw new Error("Invalid summary");
    validateArray(input.highlights, "highlights");
    if (input.highlights.length < 1) throw new Error("Invalid highlights");
    if (!input.highlights.every((t) => typeof t === "string")) throw new Error("Invalid highlights");
    validateArray(input.cautions, "cautions");
    if (!input.cautions.every((t) => typeof t === "string")) throw new Error("Invalid cautions");
    validateArray(input.tips, "tips");
    if (!input.tips.every((t) => typeof t === "string")) throw new Error("Invalid tips");
    if (typeof input.disclosure !== "string") throw new Error("Invalid disclosure");

    return {
      place_local_id: input.place_local_id,
      mode: input.mode,
      summary: input.summary,
      highlights: input.highlights,
      cautions: input.cautions,
      tips: input.tips,
      disclosure: input.disclosure,
    };
  },
  safeParse(input) {
    try {
      return { success: true, data: this.parse(input) };
    } catch (error) {
      return { success: false, error };
    }
  },
};

import { handleNearby, handlePlace } from "./handlers.js";
import { handleNearbyCached, handleNearbyRefresh } from "./nearbyPipeline.js";
import { errorResponse } from "./utils.js";

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "content-type, x-bypass-cache");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    if (request.method !== "POST") {
      return withCors(errorResponse("Method not allowed", 405));
    }

    if (url.pathname === "/v1/map/nearby") {
      if (!env.OPENAI_API_KEY) return withCors(errorResponse("Missing OPENAI_API_KEY", 500));
      return withCors(await handleNearby(request, env));
    }
    if (url.pathname === "/v1/map/place") {
      if (!env.OPENAI_API_KEY) return withCors(errorResponse("Missing OPENAI_API_KEY", 500));
      return withCors(await handlePlace(request, env));
    }
    if (url.pathname === "/v1/map/nearby_cached") {
      return withCors(await handleNearbyCached(request, env));
    }
    if (url.pathname === "/v1/map/nearby_refresh") {
      if (!env.OPENAI_API_KEY) return withCors(errorResponse("Missing OPENAI_API_KEY", 500));
      return withCors(await handleNearbyRefresh(request, env));
    }

    return withCors(errorResponse("Not found", 404));
  },
};

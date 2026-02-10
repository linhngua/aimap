import { handleAreaFacts, handleNearby, handlePlaceDetail } from "./handlers.js";
import { handleNearbyCached, handleNearbyRefresh } from "./nearbyPipeline.js";
import { handleCandidatesIngest } from "./candidatesHandler.js";
import { handleAdmin } from "./admin.js";
import { handleCoverageReport } from "./coverageHandler.js";
import { errorResponse } from "./utils.js";

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "content-type, x-bypass-cache, x-admin-token");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return withCors(await handleAdmin(request, env));
    }

    if (request.method !== "POST") {
      return withCors(errorResponse("Method not allowed", 405));
    }

    if (url.pathname === "/v1/map/nearby") {
      if (!env.OPENAI_API_KEY) return withCors(errorResponse("Missing OPENAI_API_KEY", 500));
      return withCors(await handleNearby(request, env));
    }
    if (url.pathname === "/v1/map/place_detail" || url.pathname === "/v1/map/place") {
      if (!env.OPENAI_API_KEY) return withCors(errorResponse("Missing OPENAI_API_KEY", 500));
      return withCors(await handlePlaceDetail(request, env));
    }
    if (url.pathname === "/v1/map/area_facts") {
      return withCors(await handleAreaFacts(request, env));
    }
    if (url.pathname === "/v1/map/nearby_cached") {
      return withCors(await handleNearbyCached(request, env));
    }
    if (url.pathname === "/v1/map/candidates_ingest") {
      return withCors(await handleCandidatesIngest(request, env, ctx));
    }
    if (url.pathname === "/v1/map/nearby_refresh") {
      if (!env.OPENAI_API_KEY) return withCors(errorResponse("Missing OPENAI_API_KEY", 500));
      return withCors(await handleNearbyRefresh(request, env));
    }
    if (url.pathname === "/v1/map/coverage/report") {
      return withCors(await handleCoverageReport(request, env));
    }

    return withCors(errorResponse("Not found", 404));
  },
};

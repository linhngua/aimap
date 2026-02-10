import { errorResponse, jsonResponse } from "./utils.js";
import { isSupportedLatLng, recordOutOfCoverageRequest } from "./coverage.js";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function handleCoverageReport(request, env) {
  let payloadUnknown;
  try {
    payloadUnknown = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  if (!isObject(payloadUnknown)) return errorResponse("Invalid request", 400);

  const lat = payloadUnknown.lat;
  const lng = payloadUnknown.lng;
  const sourceRaw = typeof payloadUnknown.source === "string" ? payloadUnknown.source.trim() : "";
  const source = sourceRaw.length > 0 ? sourceRaw.slice(0, 80) : "unknown";

  if (typeof lat !== "number" || typeof lng !== "number") {
    return errorResponse("Invalid request", 400, "Invalid lat/lng");
  }

  if (isSupportedLatLng(lat, lng)) {
    return jsonResponse({ status: "ok", recorded: false });
  }

  await recordOutOfCoverageRequest(env, { lat, lng, source });
  return jsonResponse({ status: "ok", recorded: true });
}


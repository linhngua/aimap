export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function errorResponse(message, status = 400, details) {
  return jsonResponse(
    {
      error: {
        message,
        details,
      },
    },
    status,
  );
}

export function getBypassCache(request) {
  const value = request.headers.get("x-bypass-cache");
  return value === "1" || value?.toLowerCase() === "true";
}

export function roundToCell(value, decimals) {
  const m = Math.pow(10, decimals);
  return Math.round(value * m) / m;
}

export function timeBucketSeconds(nowSeconds, bucketSeconds) {
  return Math.floor(nowSeconds / bucketSeconds) * bucketSeconds;
}

export function isTestMode(env) {
  const mode = env?.MODE;
  return typeof mode === "string" && mode.toLowerCase() === "test";
}

export function safeLog(env, ...args) {
  if (!isTestMode(env)) return;
  // eslint-disable-next-line no-console
  console.log(...args);
}

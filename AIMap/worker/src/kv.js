const memoryStore = new Map();

function hasKVBinding(env) {
  return env?.MAP_CACHE && typeof env.MAP_CACHE.get === "function" && typeof env.MAP_CACHE.put === "function";
}

function hasKVList(env) {
  return hasKVBinding(env) && typeof env.MAP_CACHE.list === "function";
}

export async function kvGet(env, key) {
  if (hasKVBinding(env)) {
    return await env.MAP_CACHE.get(key);
  }
  return memoryStore.get(key) ?? null;
}

export async function kvPut(env, key, value, ttlSeconds) {
  if (hasKVBinding(env)) {
    await env.MAP_CACHE.put(key, value, { expirationTtl: ttlSeconds });
    return;
  }
  memoryStore.set(key, value);
}

export async function kvList(env, { prefix, cursor, limit } = {}) {
  const resolvedPrefix = typeof prefix === "string" ? prefix : "";
  const resolvedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(1000, limit) : 200;

  if (hasKVList(env)) {
    return await env.MAP_CACHE.list({
      prefix: resolvedPrefix,
      cursor: typeof cursor === "string" && cursor.length > 0 ? cursor : undefined,
      limit: resolvedLimit,
    });
  }

  const keys = [];
  for (const key of memoryStore.keys()) {
    if (!key.startsWith(resolvedPrefix)) continue;
    keys.push({ name: key });
    if (keys.length >= resolvedLimit) break;
  }
  return { keys, list_complete: true, cursor: "" };
}

export async function kvGetJson(env, key) {
  const text = await kvGet(env, key);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function kvPutJson(env, key, value, ttlSeconds) {
  await kvPut(env, key, JSON.stringify(value), ttlSeconds);
}

const memoryStore = new Map();

function hasKVBinding(env) {
  return env?.MAP_CACHE && typeof env.MAP_CACHE.get === "function" && typeof env.MAP_CACHE.put === "function";
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


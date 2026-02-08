const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

const NEIGHBOR = {
  n: ["p0r21436x8zb9dcf5h7kjnmqesgutwvy", "bc01fg45238967deuvhjyznpkmstqrwx"],
  s: ["14365h7k9dcfesgujnmqp0r2twvyx8zb", "238967debc01fg45kmstqrwxuvhjyznp"],
  e: ["bc01fg45238967deuvhjyznpkmstqrwx", "p0r21436x8zb9dcf5h7kjnmqesgutwvy"],
  w: ["238967debc01fg45kmstqrwxuvhjyznp", "14365h7k9dcfesgujnmqp0r2twvyx8zb"],
};

const BORDER = {
  n: ["prxz", "bcfguvyz"],
  s: ["028b", "0145hjnp"],
  e: ["bcfguvyz", "prxz"],
  w: ["0145hjnp", "028b"],
};

function isString(value) {
  return typeof value === "string";
}

export function geohashAdjacent(hash, dir) {
  if (!isString(hash) || hash.length === 0) return "";
  const direction = dir.toLowerCase();
  const lastChar = hash.slice(-1);
  const type = hash.length % 2;
  let parent = hash.slice(0, -1);

  if (BORDER[direction]?.[type]?.includes(lastChar) && parent.length > 0) {
    parent = geohashAdjacent(parent, direction);
  }

  const neighborIndex = NEIGHBOR[direction]?.[type]?.indexOf(lastChar) ?? -1;
  if (neighborIndex === -1) return "";
  return parent + BASE32[neighborIndex];
}

export function geohashNeighbors(hash) {
  const n = geohashAdjacent(hash, "n");
  const s = geohashAdjacent(hash, "s");
  const e = geohashAdjacent(hash, "e");
  const w = geohashAdjacent(hash, "w");
  const ne = n ? geohashAdjacent(n, "e") : "";
  const nw = n ? geohashAdjacent(n, "w") : "";
  const se = s ? geohashAdjacent(s, "e") : "";
  const sw = s ? geohashAdjacent(s, "w") : "";
  return [n, ne, e, se, s, sw, w, nw].filter((x) => x.length > 0);
}

export function geohashDecodeBounds(hash) {
  if (!isString(hash) || hash.length === 0) return null;

  let evenBit = true;
  const lat = [-90.0, 90.0];
  const lng = [-180.0, 180.0];

  for (const char of hash) {
    const idx = BASE32.indexOf(char);
    if (idx === -1) return null;

    for (let mask = 16; mask >= 1; mask >>= 1) {
      const bit = (idx & mask) !== 0;
      if (evenBit) {
        const mid = (lng[0] + lng[1]) / 2;
        if (bit) lng[0] = mid;
        else lng[1] = mid;
      } else {
        const mid = (lat[0] + lat[1]) / 2;
        if (bit) lat[0] = mid;
        else lat[1] = mid;
      }
      evenBit = !evenBit;
    }
  }

  return { latMin: lat[0], latMax: lat[1], lngMin: lng[0], lngMax: lng[1] };
}

export function geohashCenter(hash) {
  const bounds = geohashDecodeBounds(hash);
  if (!bounds) return null;
  return {
    lat: (bounds.latMin + bounds.latMax) / 2,
    lng: (bounds.lngMin + bounds.lngMax) / 2,
  };
}

export function haversineDistanceM(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}


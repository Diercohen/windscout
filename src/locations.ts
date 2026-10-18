// Country selections expand into named datacenters, rather than one random connection.
import { LOCATION_DATA } from "./locations-data.js";

export interface Location {
  country: string;
  city: string;
  nickname: string;
}

export interface ScanTarget {
  country: string;
  query: string; // exact nickname passed to windscribe-cli
  location: string;
}

export const LOCATIONS: readonly Location[] = LOCATION_DATA.map(([country, city, nickname]) => ({ country, city, nickname }));
export const LOCATIONS_URL = "https://assets.windscribe.com/serverlist/mob-v2/1/0";

/** Only location names are needed; no server IPs, credentials or account data. */
export function parseLocations(value: unknown): Location[] {
  const data = (value as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const locations: Location[] = [];
  const seen = new Set<string>();
  for (const region of data) {
    if (!region || typeof region.country_code !== "string" || !/^[A-Z]{2}$/.test(region.country_code)
      || region.status === 0 || !Array.isArray(region.groups)) continue;
    for (const group of region.groups) {
      if (!group || group.status === 0 || typeof group.city !== "string" || typeof group.nick !== "string") continue;
      const city = group.city.trim(), nickname = group.nick.trim();
      const key = `${region.country_code}:${nickname.toLowerCase()}`;
      if (!city || !nickname || seen.has(key)) continue;
      seen.add(key);
      locations.push({ country: region.country_code, city, nickname });
    }
  }
  return locations;
}

/** Refresh before the VPN starts switching; the bundled catalog also works offline. */
export async function loadLocations(request: typeof fetch = fetch): Promise<readonly Location[]> {
  try {
    const response = await request(LOCATIONS_URL, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return LOCATIONS;
    const locations = parseLocations(await response.json());
    return locations.length ? locations : LOCATIONS;
  } catch {
    return LOCATIONS;
  }
}

/** City/nickname arguments stay specific. Countries with no catalog entry retain CLI lookup. */
export function expandLocations(queries: readonly string[], locations: readonly Location[] = LOCATIONS, limit?: number): ScanTarget[] {
  const targets: ScanTarget[] = [];
  const seen = new Set<string>();
  const add = (target: ScanTarget) => {
    const key = target.query.toLowerCase();
    if (!seen.has(key)) targets.push(target), seen.add(key);
  };
  for (const query of queries) {
    const matches = locations.filter((l) => l.country === query.toUpperCase());
    if (matches.length) {
      for (const l of matches) add({ country: l.country, query: l.nickname, location: `${l.city} - ${l.nickname}` });
    } else {
      const known = locations.find((l) => l.nickname.toLowerCase() === query.toLowerCase());
      add(known
        ? { country: known.country, query: known.nickname, location: `${known.city} - ${known.nickname}` }
        : { country: query, query, location: "" });
    }
  }
  if (limit === undefined) return targets;
  const counts = new Map<string, number>();
  return targets.filter(({ country }) => {
    const count = counts.get(country) ?? 0;
    if (count >= limit) return false;
    counts.set(country, count + 1);
    return true;
  });
}

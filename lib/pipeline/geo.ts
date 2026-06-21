import { sql } from "../db";
import { USER_AGENT } from "./util";
import { isCentroid } from "./dedup";

const LATLNG_RE = /(-?\d+\.\d+),\s*(-?\d+\.\d+)/;
const URLISH_RE = /https?:\/\/|maps\.app\.goo\.gl|google\./i;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function resolveMapUrl(url?: string | null): Promise<{ final_url: string | null; query_text: string | null; lat: number | null; lng: number | null }> {
  if (!url) return { final_url: null, query_text: null, lat: null, lng: null };
  let finalUrl = url;
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
    finalUrl = res.url || url;
  } catch {
    /* keep original */
  }
  let lat: number | null = null, lng: number | null = null, direct: string | null = null;
  try {
    const parsed = new URL(finalUrl);
    for (const key of ["q", "query", "ll", "center"]) {
      const candidate = parsed.searchParams.get(key);
      if (!candidate) continue;
      const m = LATLNG_RE.exec(candidate);
      if (m) { lat = +m[1]; lng = +m[2]; break; }
      if (direct === null) direct = candidate;
    }
  } catch { /* ignore */ }
  if (lat === null || lng === null) {
    const m = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(finalUrl);
    if (m) { lat = +m[1]; lng = +m[2]; }
  }
  return { final_url: finalUrl, query_text: direct, lat, lng };
}

function cleanPart(value?: string | null): string | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text || URLISH_RE.test(text)) return null;
  return text.replace(/\s+/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
}
function normalizeQuery(value?: string | null): string | null {
  let text = cleanPart(value);
  if (!text) return null;
  text = text.replace("C/ ", "Calle ").replace("Av. ", "Avenida ").replace("Pl. ", "Plaza ")
    .replace(" / ", " ").replace(" s/n", "").replace(/\s+/g, " ");
  return text.replace(/^[\s,]+|[\s,]+$/g, "");
}
function joinParts(parts: (string | null | undefined)[]): string | null {
  const out: string[] = [];
  for (const p of parts) {
    const c = cleanPart(p);
    if (c && !out.includes(c)) out.push(c);
  }
  return out.join(", ") || null;
}

// Spanish street-type prefixes that start an address segment (ES + Valencian).
const STREET_RE = /^(carrer|calle|c\/|avinguda|avenida|av\.?|pla[çc]a|plaza|pl\.?|passeig|paseo|cam[íi]|camino|ronda|gran via|via|partida|pol[íi]gono)(\s|$)/i;

// PURE: build the BEST Nominatim query from a Google-Maps `q=` text. The maps `q=` leads
// with the VENUE NAME ("HANAZONO - Benimaclet, Carrer …, 3, …, 46020 València, Valencia"),
// which fools Nominatim into the city-centre fallback. Extracting just the street address
// ("Carrer del Doctor Garcia Brustenga 3, 46020 València, Spain") resolves to the EXACT
// venue. Returns null when no street segment is present (caller falls back to other queries).
export function mapsAddressQuery(qText?: string | null): string | null {
  if (!qText) return null;
  const segs = qText.split(",").map((s) => s.trim()).filter(Boolean);
  const streetIdx = segs.findIndex((s) => STREET_RE.test(s));
  if (streetIdx === -1) return null;
  let street = segs[streetIdx]
    .replace(/^C\/\s*/i, "Calle ")
    .replace(/^Av\.?\s+/i, "Avenida ")
    .replace(/^Pl\.?\s+/i, "Plaza ")
    .replace(/\s+/g, " ")
    .trim();
  const next = segs[streetIdx + 1];
  const number = next && /^\d+[a-z]?$/i.test(next) ? next : "";
  // Prefer the "<postcode> <city>" segment; if there is none, fall back to the last
  // segment as the city (so the query is never just a bare street, which Nominatim can't
  // disambiguate across Spain).
  let locale = segs.find((s) => /\b\d{5}\b/.test(s)) || null;
  if (!locale) {
    const last = segs[segs.length - 1];
    if (last && last !== segs[streetIdx] && last !== number) locale = last;
  }
  const parts = [number ? `${street} ${number}` : street];
  if (locale) parts.push(locale);
  parts.push("Spain");
  return parts.join(", ");
}

async function geocodeText(query: string): Promise<{ lat: number | null; lng: number | null; display: string | null }> {
  if (!query) return { lat: null, lng: null, display: null };
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(query);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return { lat: null, lng: null, display: null };
    return { lat: +data[0].lat, lng: +data[0].lon, display: data[0].display_name || null };
  } catch {
    return { lat: null, lng: null, display: null };
  }
}

export interface ResolvedGeo {
  lat: number | null;
  lng: number | null;
  geo_source: string | null;
  note: string | null;
  mapsQuery: string | null; // the maps `q=` text (authoritative name+address), pre-geocode
}

// Resolve ONE place/venue's coordinates: follow its maps_url for direct coords, else
// geocode (Nominatim) a prioritized query list — the maps `q=` address first, then
// name/address composites. Extracted from the geoEnrich places loop so a one-off seed
// geo-baking pass (scripts/bake-place-geo.mjs) and the live pipeline share IDENTICAL
// resolution (no drift). Paces Nominatim by delayMs. DB-free / network-only.
export async function resolvePlaceGeo(
  row: { maps_url?: string | null; name?: string | null; address?: string | null; city?: string | null },
  delayMs = 1100,
): Promise<ResolvedGeo> {
  const map = await resolveMapUrl(row.maps_url);
  let lat = map.lat,
    lng = map.lng;
  let source: string | null = "map_url";
  let note: string | null = map.query_text;
  if (lat == null || lng == null) {
    const queries = [
      // Street address FIRST — the maps `q=` leads with the venue name, which fools
      // Nominatim into the city-centre fallback; the bare address resolves to the venue.
      mapsAddressQuery(map.query_text),
      normalizeQuery(map.query_text),
      joinParts([row.name, row.city || "Valencia", "Spain"]),
      joinParts([row.address, row.city || "Valencia", "Spain"]),
      joinParts([row.name, row.address, row.city || "Valencia", "Spain"]),
    ].filter((q, i, a) => q && a.indexOf(q) === i) as string[];
    for (const q of queries) {
      const r = await geocodeText(q);
      await sleep(delayMs);
      // Reject centroid/city-fallback hits — a misleading pin at the city centre is worse
      // than none. Only accept a real, distinct coordinate.
      if (r.lat != null && r.lng != null && !isCentroid(r.lat, r.lng)) {
        lat = r.lat;
        lng = r.lng;
        note = r.display || q;
        source = "nominatim";
        break;
      }
    }
  }
  if (lat == null || lng == null) return { lat: null, lng: null, geo_source: null, note, mapsQuery: map.query_text };
  return { lat, lng, geo_source: source, note, mapsQuery: map.query_text };
}

// PURE: build the prioritized Nominatim query list for an EVENT, deduped, in priority
// order. The maps `q=` address (when the venue_url carried one) ranks first; then the
// VENUE-NAME fallback (T161) — many derived events have a clear venue_name (Roig Arena,
// Plaza de Toros de Valencia, …) but NO address, so without this they never geocode at
// all. `<venue_name>, <city||Valencia>, Spain` resolves a lot of them to a real pin
// (the isCentroid guard in the caller rejects the venue-name hits that only land on a
// city-centre fallback, e.g. Teatro Olympia — better null than a fake pin).
export function eventGeoQueries(
  row: { venue_name?: string | null; address?: string | null; city?: string | null },
  mapsQueryText?: string | null,
): string[] {
  const city = row.city || "Valencia";
  return [
    mapsAddressQuery(mapsQueryText),
    normalizeQuery(mapsQueryText),
    joinParts([row.venue_name, city, "Spain"]),
    joinParts([row.address, city, "Spain"]),
    joinParts([row.venue_name, row.address, city, "Spain"]),
  ].filter((q, i, a) => q && a.indexOf(q) === i) as string[];
}

export async function geoEnrich(limit = 40, delayMs = 1100): Promise<{ events_updated: number; places_updated: number }> {
  let eventsUpdated = 0, placesUpdated = 0;

  const events = (await sql`
    SELECT * FROM events
    WHERE (lat IS NULL OR lng IS NULL)
      AND (venue_url IS NOT NULL OR address IS NOT NULL OR venue_name IS NOT NULL)
    ORDER BY score DESC NULLS LAST, last_seen DESC LIMIT ${limit}
  `) as any[];
  for (const row of events) {
    const map = await resolveMapUrl(row.venue_url);
    let { lat, lng } = map;
    let source = "map_url", note = map.query_text;
    if (lat == null || lng == null) {
      const queries = eventGeoQueries(row, map.query_text);
      for (const q of queries) {
        const r = await geocodeText(q);
        await sleep(delayMs);
        // Reject centroid/city-fallback hits — a misleading pin at the city centre is
        // worse than none (mirrors resolvePlaceGeo). Only accept a real, distinct coord.
        if (r.lat != null && r.lng != null && !isCentroid(r.lat, r.lng)) {
          lat = r.lat; lng = r.lng; note = r.display || q; source = "nominatim";
          break;
        }
      }
    }
    if (lat != null && lng != null) {
      await sql`UPDATE events SET lat = ${lat}, lng = ${lng}, geo_source = ${source},
        location_notes = COALESCE(location_notes, ${note}) WHERE id = ${row.id}`;
      eventsUpdated++;
    }
  }

  const places = (await sql`
    SELECT * FROM places
    WHERE (lat IS NULL OR lng IS NULL)
      AND (maps_url IS NOT NULL OR address IS NOT NULL OR name IS NOT NULL)
    ORDER BY last_seen DESC LIMIT ${limit}
  `) as any[];
  for (const row of places) {
    const g = await resolvePlaceGeo(row, delayMs);
    if (g.lat != null && g.lng != null) {
      await sql`UPDATE places SET lat = ${g.lat}, lng = ${g.lng}, geo_source = ${g.geo_source},
        location_notes = COALESCE(location_notes, ${g.note}) WHERE id = ${row.id}`;
      placesUpdated++;
    }
  }

  return { events_updated: eventsUpdated, places_updated: placesUpdated };
}

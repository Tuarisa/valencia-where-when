import { sql } from "../db";
import { USER_AGENT } from "./util";

const LATLNG_RE = /(-?\d+\.\d+),\s*(-?\d+\.\d+)/;
const URLISH_RE = /https?:\/\/|maps\.app\.goo\.gl|google\./i;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveMapUrl(url?: string | null): Promise<{ final_url: string | null; query_text: string | null; lat: number | null; lng: number | null }> {
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
      const queries = [
        normalizeQuery(map.query_text),
        joinParts([row.venue_name, row.city || "Valencia", "Spain"]),
        joinParts([row.address, row.city || "Valencia", "Spain"]),
        joinParts([row.venue_name, row.address, row.city || "Valencia", "Spain"]),
      ].filter((q, i, a) => q && a.indexOf(q) === i) as string[];
      for (const q of queries) {
        const r = await geocodeText(q);
        note = r.display || q; source = "nominatim";
        await sleep(delayMs);
        if (r.lat != null && r.lng != null) { lat = r.lat; lng = r.lng; break; }
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
    const map = await resolveMapUrl(row.maps_url);
    let { lat, lng } = map;
    let source = "map_url", note = map.query_text;
    if (lat == null || lng == null) {
      const queries = [
        normalizeQuery(map.query_text),
        joinParts([row.name, row.city || "Valencia", "Spain"]),
        joinParts([row.address, row.city || "Valencia", "Spain"]),
        joinParts([row.name, row.address, row.city || "Valencia", "Spain"]),
      ].filter((q, i, a) => q && a.indexOf(q) === i) as string[];
      for (const q of queries) {
        const r = await geocodeText(q);
        note = r.display || q; source = "nominatim";
        await sleep(delayMs);
        if (r.lat != null && r.lng != null) { lat = r.lat; lng = r.lng; break; }
      }
    }
    if (lat != null && lng != null) {
      await sql`UPDATE places SET lat = ${lat}, lng = ${lng}, geo_source = ${source},
        location_notes = COALESCE(location_notes, ${note}) WHERE id = ${row.id}`;
      placesUpdated++;
    }
  }

  return { events_updated: eventsUpdated, places_updated: placesUpdated };
}

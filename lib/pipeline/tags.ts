import { sql } from "../db";
import { slugify } from "../format";

function textBlob(row: any, nameField: string): string {
  return [
    row[nameField], row.description, row.raw_excerpt, row.venue_name,
    row.address, row.district, row.area, row.occasion, row.notes,
  ].filter(Boolean).map(String).join(" ").toLowerCase();
}

function addSlug(tags: Set<string>, prefix: string, value: any) {
  const s = slugify(value);
  if (s) tags.add(`${prefix}:${s}`);
}

const EVENT_KEYWORDS: Record<string, string[]> = {
  family: ["family", "kids", "дет", "niños", "семейн"],
  outdoor: ["outdoor", "marina", "playa", "beach", "park", "parque"],
  music: ["concert", "music", "festival", "arena", "band", "dj"],
  standup: ["stand up", "стендап", "comedy"],
  gastro: ["paella", "burger", "wine", "food", "gastro"],
  cinema: ["cine", "film", "кіно", "movie"],
  art: ["art", "museum", "museo", "gallery", "exhibition", "вистав"],
  expat: ["русск", "ukrain", "укра", "соотечествен", "expat"],
};

const PLACE_KEYWORDS: Record<string, string[]> = {
  family: ["kids", "сем", "family", "child"],
  "date-night": ["date", "cocktail", "romantic", "romance"],
  group: ["company", "group", "friends", "компан"],
  pool: ["pool", "piscina", "бассейн", "басейн"],
  coffee: ["coffee", "cafe", "cafeter"],
  food: ["restaurant", "food", "restaurante", "бар", "brunch", "tapas"],
};

export function inferEventTags(row: any): string[] {
  const tags = new Set<string>(["event"]);
  const text = textBlob(row, "title");
  for (const f of ["category", "language", "audience", "source"]) {
    const s = slugify(row[f]);
    if (s) tags.add(s);
  }
  addSlug(tags, "city", row.city);
  addSlug(tags, "district", row.district);
  if (row.is_free === 1) tags.add("free");
  if (row.start_time) tags.add("timed");
  if (row.image_url) tags.add("has-image");
  if (row.venue_url || row.lat != null) tags.add("mapped");
  if (row.score && Number(row.score) >= 80) tags.add("top-pick");
  for (const [tag, needles] of Object.entries(EVENT_KEYWORDS)) {
    if (needles.some((n) => text.includes(n))) tags.add(tag);
  }
  return Array.from(tags).sort();
}

export function inferPlaceTags(row: any): string[] {
  const tags = new Set<string>(["place"]);
  const text = textBlob(row, "name");
  for (const f of ["category", "source", "price_level"]) {
    const s = slugify(row[f]);
    if (s) tags.add(s);
  }
  addSlug(tags, "city", row.city);
  addSlug(tags, "district", row.district);
  addSlug(tags, "area", row.area);
  if (row.maps_url || row.lat != null) tags.add("mapped");
  if (row.image_url) tags.add("has-image");
  for (const [tag, needles] of Object.entries(PLACE_KEYWORDS)) {
    if (needles.some((n) => text.includes(n))) tags.add(tag);
  }
  for (const chunk of String(row.occasion || "").toLowerCase().split(/[,;]\s*/)) {
    const s = slugify(chunk);
    if (s) tags.add(s);
  }
  return Array.from(tags).sort();
}

export async function tagAll(): Promise<{ events: number; places: number }> {
  const events = (await sql`SELECT * FROM events`) as any[];
  if (events.length > 0) {
    // Batch: one UPDATE joins against parallel id[]/tags_json[] arrays instead of N
    // per-row UPDATEs (one Neon HTTP round-trip per statement — F4/T184). Tags are
    // still computed per-row in JS; only the WRITE collapses to O(1).
    const ids: number[] = [];
    const tags: string[] = [];
    for (const e of events) {
      ids.push(e.id);
      tags.push(JSON.stringify(inferEventTags(e)));
    }
    await sql`
      UPDATE events AS e SET tags_json = v.tags_json
      FROM unnest(${ids}::int[], ${tags}::text[]) AS v(id, tags_json)
      WHERE e.id = v.id
    `;
  }
  const places = (await sql`SELECT * FROM places`) as any[];
  if (places.length > 0) {
    const ids: number[] = [];
    const tags: string[] = [];
    for (const p of places) {
      ids.push(p.id);
      tags.push(JSON.stringify(inferPlaceTags(p)));
    }
    await sql`
      UPDATE places AS p SET tags_json = v.tags_json
      FROM unnest(${ids}::int[], ${tags}::text[]) AS v(id, tags_json)
      WHERE p.id = v.id
    `;
  }
  return { events: events.length, places: places.length };
}

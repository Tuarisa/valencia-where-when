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
  for (const e of events) {
    const tags = JSON.stringify(inferEventTags(e));
    await sql`UPDATE events SET tags_json = ${tags} WHERE id = ${e.id}`;
  }
  const places = (await sql`SELECT * FROM places`) as any[];
  for (const p of places) {
    const tags = JSON.stringify(inferPlaceTags(p));
    await sql`UPDATE places SET tags_json = ${tags} WHERE id = ${p.id}`;
  }
  return { events: events.length, places: places.length };
}

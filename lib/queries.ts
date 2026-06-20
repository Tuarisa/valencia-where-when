import { sql, nowIso } from "./db";
import {
  deriveTitle,
  excerpt,
  formatDateLabel,
  eventLocationLabel,
  placeLocationLabel,
  loadTags,
  pageSlug,
} from "./format";

export const VALENCIA_CENTER = { lat: 39.4699, lng: -0.3763 };

export type EventRow = Record<string, any>;
export type PlaceRow = Record<string, any>;

export interface SiteEvent {
  id: number;
  title: string;
  description: string | null;
  excerpt: string;
  is_hemisferic: boolean;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  date_label: string;
  location_label: string;
  venue_name: string | null;
  district: string | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  price: string | null;
  category: string | null;
  language: string | null;
  audience: string | null;
  score: number | null;
  image_url: string | null;
  url: string | null;
  venue_url: string | null;
  source: string | null;
  source_url: string | null;
  tags: string[];
  page_url: string;
}

export interface SitePlace {
  id: number;
  name: string;
  description: string | null;
  excerpt: string;
  category: string | null;
  area: string | null;
  district: string | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  maps_url: string | null;
  image_url: string | null;
  source: string | null;
  source_url: string | null;
  location_label: string;
  tags: string[];
  page_url: string;
}

export interface SitePayload {
  generated_at: string;
  today: string;
  default_month: string | null;
  stats: {
    events: number;
    places: number;
    mapped_places: number;
    mapped_events: number;
    tag_count: number;
  };
  months: string[];
  top_tags: string[];
  map_center: { lat: number; lng: number };
  events: SiteEvent[];
  places: SitePlace[];
}

function displayTitle(row: EventRow): string {
  return row.title_ru || deriveTitle(row.title);
}

export function toSiteEvent(row: EventRow): SiteEvent {
  const title = displayTitle(row);
  const slug = pageSlug(title, `event-${row.id}`);
  const tags = loadTags(row.tags_json);
  return {
    id: row.id,
    title,
    description: row.description ?? null,
    excerpt: excerpt(row.description || row.raw_excerpt),
    is_hemisferic: row.source === "api:hemisferic",
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    start_time: row.start_time ?? null,
    date_label: formatDateLabel(row.start_date, row.end_date, row.start_time),
    location_label: eventLocationLabel(row),
    venue_name: row.venue_name ?? null,
    district: row.district ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    price: row.price ?? null,
    category: row.category ?? null,
    language: row.language ?? null,
    audience: row.audience ?? null,
    score: row.score ?? null,
    image_url: row.image_url ?? null,
    url: row.url ?? null,
    venue_url: row.venue_url ?? null,
    source: row.source ?? null,
    source_url: row.source_url ?? null,
    tags,
    page_url: `/events/${row.id}-${slug}`,
  };
}

export function toSitePlace(row: PlaceRow): SitePlace {
  const slug = pageSlug(row.name, `place-${row.id}`);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    excerpt: excerpt(row.description || row.notes),
    category: row.category ?? null,
    area: row.area ?? null,
    district: row.district ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    maps_url: row.maps_url ?? null,
    image_url: row.image_url ?? null,
    source: row.source ?? null,
    source_url: row.source_url ?? null,
    location_label: placeLocationLabel(row),
    tags: loadTags(row.tags_json),
    page_url: `/places/${row.id}-${slug}`,
  };
}

export async function getEvents(): Promise<SiteEvent[]> {
  const rows = (await sql`
    SELECT * FROM events
    WHERE status = 'upcoming' OR status IS NULL
    ORDER BY score DESC NULLS LAST, start_date, title
  `) as EventRow[];
  return rows.map(toSiteEvent);
}

export async function getPlaces(): Promise<SitePlace[]> {
  const rows = (await sql`
    SELECT * FROM places ORDER BY last_seen DESC, name
  `) as PlaceRow[];
  return rows.map(toSitePlace);
}

export async function getEventRow(id: number): Promise<EventRow | null> {
  const rows = (await sql`SELECT * FROM events WHERE id = ${id}`) as EventRow[];
  return rows[0] || null;
}

export async function getPlaceRow(id: number): Promise<PlaceRow | null> {
  const rows = (await sql`SELECT * FROM places WHERE id = ${id}`) as PlaceRow[];
  return rows[0] || null;
}

export async function getMedia(entityType: "event" | "place", entityId: number) {
  return (await sql`
    SELECT * FROM media_assets
    WHERE entity_type = ${entityType} AND entity_id = ${entityId}
    ORDER BY is_primary DESC, sort_order, id
  `) as Record<string, any>[];
}

export async function buildPayload(): Promise<SitePayload> {
  const [events, places] = await Promise.all([getEvents(), getPlaces()]);

  const monthSet = new Set<string>();
  for (const e of events) if (e.start_date) monthSet.add(e.start_date.slice(0, 7));
  const months = Array.from(monthSet).sort();

  const todayMonth = new Date().toISOString().slice(0, 7);
  const futureMonths = months.filter((m) => m >= todayMonth);
  const defaultMonth = futureMonths[0] || months[months.length - 1] || null;

  const tagCounts = new Map<string, number>();
  for (const e of events) for (const t of e.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([t]) => t);

  const mappedPlaces = places.filter((p) => p.lat != null && p.lng != null).length;
  const mappedEvents = events.filter((e) => e.lat != null && e.lng != null).length;
  const allTags = new Set<string>();
  for (const e of events) for (const t of e.tags) allTags.add(t);
  for (const p of places) for (const t of p.tags) allTags.add(t);

  return {
    generated_at: nowIso(),
    today: new Date().toISOString().slice(0, 10),
    default_month: defaultMonth,
    stats: {
      events: events.length,
      places: places.length,
      mapped_places: mappedPlaces,
      mapped_events: mappedEvents,
      tag_count: allTags.size,
    },
    months,
    top_tags: topTags,
    map_center: VALENCIA_CENTER,
    events,
    places,
  };
}

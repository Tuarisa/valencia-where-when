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
  // Recurring-series rendering (sub-area D, T043). A series surfaces as ONE feed card
  // (is_series, occurrence_count) PLUS N calendar-only occurrence rows
  // (calendar_only) bucketed onto their own dates. Ordinary single-shot events leave
  // all three at their defaults (false / 0 / false).
  is_series: boolean; // the representative feed card for an event_series
  occurrence_count: number; // sessions in the series (0 for ordinary events)
  series_id: number | null; // event_series.id this row belongs to (card or occurrence)
  calendar_only: boolean; // an occurrence row: shown on the calendar, hidden from the feed
  feature: string | null; // special-event kind for color coding: feria | festival | hemisferic | excursion | exposition | null
  // Standing/long-running events (exhibitions) that run continuously over a multi-day
  // [start_date, end_date] span (T175). The calendar renders these as ONE horizontal
  // spanning bar in a top lane (not a per-day card duplicated across the range), and
  // the feed shows an "ongoing" badge instead of a single date.
  is_exposition: boolean;
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
  // Frequency-weighted tag cloud (T163): every distinct tag across feed-visible events
  // (+ places), with its occurrence count, sorted most-frequent first and capped. The
  // feed sidebar renders these sized by `count` and clicking one filters the feed.
  tag_cloud: { tag: string; count: number }[];
  // Distinct event categories present in the feed, with counts (T163) — drives the
  // category-chip filter bar. Sorted by count desc, then name, capped.
  categories: { category: string; count: number }[];
  map_center: { lat: number; lng: number };
  events: SiteEvent[];
  places: SitePlace[];
}

// Frequency-weighted tag cloud (T163). Aggregates tags across the feed-visible events
// and places, weights each by its total occurrence count, and returns the top `limit`
// sorted most-frequent first (ties broken alphabetically for deterministic SSR).
const TAG_CLOUD_LIMIT = 36;
export function buildTagCloud(
  events: SiteEvent[],
  places: SitePlace[],
  limit = TAG_CLOUD_LIMIT,
): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of events) for (const t of e.tags) counts.set(t, (counts.get(t) || 0) + 1);
  for (const p of places) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

// Distinct event categories present in the feed, with counts (T163). Drives the
// category-chip filter bar. Deterministic order: count desc, then name.
const CATEGORY_LIMIT = 14;
export function buildCategories(
  events: SiteEvent[],
  limit = CATEGORY_LIMIT,
): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    const c = (e.category || "").trim().toLowerCase();
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([category, count]) => ({ category, count }));
}

function displayTitle(row: EventRow): string {
  return row.title_ru || deriveTitle(row.title);
}

// Day-span helper: whole-day count between two ISO dates (end − start), or null.
function spanDays(startDate?: string | null, endDate?: string | null): number | null {
  if (!startDate || !endDate) return null;
  const s = Date.parse(startDate.slice(0, 10));
  const e = Date.parse(endDate.slice(0, 10));
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  return Math.round((e - s) / 86_400_000);
}

// Detect a "standing" exhibition (T175): an event that runs CONTINUOUSLY over a genuine
// multi-day [start_date, end_date] span (≥ MIN_EXPO_SPAN_DAYS apart) AND reads as an
// exhibition — by an explicit exhibition title/category signal (RU выстав/экспоз,
// ES exposición, EN exhibition), OR a 'culture' category that carries such a span.
// These are rendered as one spanning calendar bar, not a per-day card. Deterministic.
const MIN_EXPO_SPAN_DAYS = 4;
const EXPO_TEXT_RE = /выстав|экспоз|exposici[oó]n|exhibition/i;
export function isExposition(row: EventRow): boolean {
  const days = spanDays(row.start_date, row.end_date);
  if (days == null || days < MIN_EXPO_SPAN_DAYS) return false;
  const cat = (row.category || "").toLowerCase();
  const text = `${row.title || ""} ${row.category || ""}`;
  if (EXPO_TEXT_RE.test(text)) return true;
  // A multi-day 'culture' event with no other explicit kind reads as an exposition too.
  return cat === "culture";
}

// Categorize "special" events so the calendar/feed can color them distinctly (T133).
// Extensible: each kind maps to its own accent in globals.css. Returns null for an
// ordinary event.
export function featureKind(row: EventRow): string | null {
  const src = row.source || "";
  if (src === "api:hemisferic") return "hemisferic";
  if (src === "web:feriadejuliovlc") return "feria";
  const cat = (row.category || "").toLowerCase();
  // Guided excursions / day-tours (T142, tg:rutatuta_vlc) get their own accent so they
  // stand out from the generic-event feed.
  if (src === "tg:rutatuta_vlc" || cat === "excursion") return "excursion";
  const tags = loadTags(row.tags_json);
  if (tags.includes("feria-de-julio")) return "feria";
  if (cat === "festival" || cat === "fireworks") return "festival";
  if (tags.includes("festival") || tags.includes("featured")) return "festival";
  // Standing exhibitions (T175) — checked AFTER the festival/feria kinds so an explicit
  // festival span doesn't get reclassified, but before the null fall-through.
  if (isExposition(row)) return "exposition";
  return null;
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
    is_series: false,
    occurrence_count: 0,
    series_id: null,
    calendar_only: false,
    feature: featureKind(row),
    is_exposition: isExposition(row),
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

// Recurring series → SiteEvent rows (sub-area D, T043). Each upcoming series becomes:
//   • ONE representative feed card (is_series, occurrence_count = N sessions), dated at
//     the series start_date so it sorts into the feed by score like any other card; and
//   • N calendar-only occurrence rows (calendar_only), one per session, each dated on
//     its own occurrence_date + start_time so the calendar's per-day .day-hemis
//     collapsible keeps working.
// All rows are flagged is_hemisferic (the existing color/legend) and carry series_id.
// Deterministic SSR: ordered by score then date then title, sessions by date+time.
export function seriesToSiteEvents(
  series: EventRow,
  occurrences: EventRow[],
): SiteEvent[] {
  const title = series.title_ru || deriveTitle(series.title);
  const slug = pageSlug(title, `series-${series.id}`);
  const tags = loadTags(series.tags_json);
  const pageUrl = `/events/series-${series.id}-${slug}`;
  const sorted = [...occurrences].sort((a, b) => {
    const da = (a.occurrence_date || "") + (a.start_time || "99:99");
    const db = (b.occurrence_date || "") + (b.start_time || "99:99");
    return da.localeCompare(db);
  });

  const base = {
    title,
    description: series.description ?? null,
    excerpt: excerpt(series.description || series.raw_excerpt),
    is_hemisferic: series.source === "api:hemisferic",
    feature: featureKind(series),
    is_exposition: false, // recurring series render via occurrence rows, not a span bar
    end_date: series.end_date ?? null,
    venue_name: series.venue_name ?? null,
    district: series.district ?? null,
    address: series.address ?? null,
    city: series.city ?? null,
    lat: series.lat ?? null,
    lng: series.lng ?? null,
    price: series.price ?? null,
    category: series.category ?? null,
    language: series.language ?? null,
    audience: series.audience ?? null,
    score: series.score ?? null,
    image_url: series.image_url ?? null,
    url: series.url ?? null,
    venue_url: series.venue_url ?? null,
    source: series.source ?? null,
    source_url: series.source_url ?? null,
    tags,
    page_url: pageUrl,
    series_id: series.id,
  };

  // The feed card: one per series, dated at the series start (carries occurrence_count).
  const card: SiteEvent = {
    ...base,
    id: 1_000_000_000 + series.id, // synthetic, collision-free vs events.id (React key)
    is_series: true,
    occurrence_count: sorted.length,
    calendar_only: false,
    start_date: series.start_date ?? null,
    start_time: null,
    date_label: formatDateLabel(series.start_date, series.end_date, null),
    location_label: eventLocationLabel(series),
  };

  // The calendar rows: one per occurrence, on its own date/time (hidden from the feed).
  const occRows: SiteEvent[] = sorted.map((o) => ({
    ...base,
    id: 2_000_000_000 + (o.id as number), // synthetic, distinct from card + events.id
    is_series: false,
    occurrence_count: 0,
    calendar_only: true,
    start_date: o.occurrence_date ?? null,
    start_time: o.start_time ?? null,
    date_label: formatDateLabel(o.occurrence_date, null, o.start_time),
    location_label: eventLocationLabel(series),
  }));

  return [card, ...occRows];
}

export async function getSeriesEvents(): Promise<SiteEvent[]> {
  const series = (await sql`
    SELECT * FROM event_series
    WHERE status = 'upcoming' OR status IS NULL
    ORDER BY score DESC NULLS LAST, start_date, title
  `) as EventRow[];
  if (series.length === 0) return [];

  const ids = series.map((s) => s.id as number);
  const occ = (await sql`
    SELECT * FROM event_occurrences
    WHERE series_id = ANY(${ids})
      AND (status = 'upcoming' OR status IS NULL)
    ORDER BY series_id, occurrence_date, start_time
  `) as EventRow[];

  const bySeries = new Map<number, EventRow[]>();
  for (const o of occ) {
    const sid = o.series_id as number;
    if (!bySeries.has(sid)) bySeries.set(sid, []);
    bySeries.get(sid)!.push(o);
  }

  const out: SiteEvent[] = [];
  for (const s of series) out.push(...seriesToSiteEvents(s, bySeries.get(s.id as number) || []));
  return out;
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

// Series detail (T043): the series row + its upcoming occurrences (the full schedule),
// for the /events/series-<id> detail page. Deterministic order by date+time.
export async function getSeriesDetail(
  id: number,
): Promise<{ series: EventRow; occurrences: EventRow[] } | null> {
  const rows = (await sql`SELECT * FROM event_series WHERE id = ${id}`) as EventRow[];
  if (!rows[0]) return null;
  const occurrences = (await sql`
    SELECT * FROM event_occurrences
    WHERE series_id = ${id} AND (status = 'upcoming' OR status IS NULL)
    ORDER BY occurrence_date, start_time
  `) as EventRow[];
  return { series: rows[0], occurrences };
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
  const [singleEvents, seriesRows, places] = await Promise.all([
    getEvents(),
    getSeriesEvents(),
    getPlaces(),
  ]);

  // Feed/calendar source rows = ordinary events ∪ series-derived rows (cards +
  // occurrences). The now-'duplicate' raw Hemisfèric events already drop out of
  // getEvents() (status filter), so this ADDS the series rows without double-counting.
  // Deterministic SSR ordering mirrors getEvents(): score DESC, then date, then title.
  const events = [...singleEvents, ...seriesRows].sort((a, b) => {
    const sa = a.score ?? -1;
    const sb = b.score ?? -1;
    if (sa !== sb) return sb - sa;
    const da = a.start_date || "9999-99-99";
    const db = b.start_date || "9999-99-99";
    if (da !== db) return da.localeCompare(db);
    return a.title.localeCompare(b.title);
  });

  // Stats/tags count FEED-VISIBLE rows only (a series counts once via its card; the
  // calendar-only occurrence rows are excluded so they don't inflate the totals).
  const feedEvents = events.filter((e) => !e.calendar_only);

  const monthSet = new Set<string>();
  for (const e of events) if (e.start_date) monthSet.add(e.start_date.slice(0, 7));
  const months = Array.from(monthSet).sort();

  const todayMonth = new Date().toISOString().slice(0, 7);
  const futureMonths = months.filter((m) => m >= todayMonth);
  const defaultMonth = futureMonths[0] || months[months.length - 1] || null;

  const tagCounts = new Map<string, number>();
  for (const e of feedEvents) for (const t of e.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([t]) => t);

  const mappedPlaces = places.filter((p) => p.lat != null && p.lng != null).length;
  const mappedEvents = feedEvents.filter((e) => e.lat != null && e.lng != null).length;
  const allTags = new Set<string>();
  for (const e of feedEvents) for (const t of e.tags) allTags.add(t);
  for (const p of places) for (const t of p.tags) allTags.add(t);

  return {
    generated_at: nowIso(),
    today: new Date().toISOString().slice(0, 10),
    default_month: defaultMonth,
    stats: {
      events: feedEvents.length,
      places: places.length,
      mapped_places: mappedPlaces,
      mapped_events: mappedEvents,
      tag_count: allTags.size,
    },
    months,
    top_tags: topTags,
    tag_cloud: buildTagCloud(feedEvents, places),
    categories: buildCategories(feedEvents),
    map_center: VALENCIA_CENTER,
    events,
    places,
  };
}

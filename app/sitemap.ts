import type { MetadataRoute } from "next";
import { sql } from "@/lib/db";
import { toSiteEvent, toSitePlace, type EventRow, type PlaceRow } from "@/lib/queries";

// Served fresh from the DB on every crawl (content is refreshed by the cron pipeline).
// force-dynamic also keeps `npm run build` from prerendering this route — the local
// gate build has no live DATABASE_URL, so a build-time query would fail.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const BASE = (process.env.APP_BASE_URL || "https://valencia-where-when.vercel.app").replace(/\/$/, "");

// last_seen is ISO text (nowIso); tolerate missing/garbled values → omit lastModified.
function toDate(value?: string | null): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, lastModified: new Date(), changeFrequency: "daily", priority: 1.0 },
    { url: `${BASE}/places`, lastModified: new Date(), changeFrequency: "daily", priority: 0.8 },
  ];

  try {
    // Upcoming DATED events only (getEvents' feed predicate minus its null-date rows —
    // undated events have nothing to rank for). Dates are 'YYYY-MM-DD' TEXT, so compare
    // lexically against today's date string, same as lib/queries.ts.
    const eventRows = (await sql`
      SELECT * FROM events
      WHERE status = 'upcoming'
        AND start_date IS NOT NULL
        AND COALESCE(end_date, start_date) >= to_char(CURRENT_DATE, 'YYYY-MM-DD')
      ORDER BY start_date, id
    `) as EventRow[];
    const placeRows = (await sql`SELECT * FROM places ORDER BY id`) as PlaceRow[];

    // Reuse the canonical href builders (page_url = /events/<id>-<slug>,
    // /places/<id>-<slug>) so sitemap URLs match the on-site links byte-for-byte.
    const eventEntries: MetadataRoute.Sitemap = eventRows.map((row) => ({
      url: `${BASE}${toSiteEvent(row).page_url}`,
      lastModified: toDate(row.last_seen),
      changeFrequency: "weekly",
      priority: 0.7,
    }));
    const placeEntries: MetadataRoute.Sitemap = placeRows.map((row) => ({
      url: `${BASE}${toSitePlace(row).page_url}`,
      lastModified: toDate(row.last_seen),
      changeFrequency: "monthly",
      priority: 0.5,
    }));

    return [...staticEntries, ...eventEntries, ...placeEntries];
  } catch (err) {
    // No DB (local gate build) or a transient outage: a partial sitemap beats a 500.
    console.warn("sitemap: DB unavailable, serving static entries only:", err);
    return staticEntries;
  }
}

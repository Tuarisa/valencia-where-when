// T042 — Migrate the existing Hemisfèric `events` into the recurring series model.
//
// The seed DB carries 104 single-shot `events` WHERE source='api:hemisferic' across
// 11 distinct shows (films). The recurrence model (sub-area D) represents each show as
// ONE `event_series` (the card) + N `event_occurrences` (the dated sessions that feed
// the calendar). This script regenerates that model FROM the existing `events` rows
// (the hemisfèric `source_items` are empty in this seed), reusing the SAME identity
// rules as lib/pipeline/series.ts (seriesHash / occurrenceHash) and the idempotent
// upsertSeries — so re-running inserts 0 new rows and never resets enrichment state.
//
// After migrating, the 104 source events are marked status='duplicate' +
// metadata_json.merged_into_series=<series_id> so getEvents() (status='upcoming' OR
// NULL) drops them from the feed. They are NEVER deleted (constitution I, append-only).
//
//   Usage: DATABASE_URL=... node --import tsx scripts/migrate-hemisferic-series.mjs
//
import { neon } from "@neondatabase/serverless";
import { applyLocalNeonConfig } from "./_neon-local.mjs";
import { upsertSeries, seriesHash } from "../lib/pipeline/series.ts";
import { nowIso } from "../lib/pipeline/util.ts";

const HEMISFERIC_SOURCE_KEY = "api:hemisferic";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Export it (local: db.localtest.me).");
  process.exit(1);
}
applyLocalNeonConfig(url);
const sql = neon(url);

// PURE: group the source `events` rows by show using the SAME identity as series.ts
// (seriesHash keys on norm(title)|norm(venue_name)|source). Every hemisfèric row shares
// the venue + source, so this collapses to one group per distinct show. Returns, per
// group, the SeriesDraft, its OccurrenceDrafts (one per member event), and the member
// event ids (for the supersede pass).
export function groupHemisfericEvents(rows) {
  const byHash = new Map();
  for (const r of rows) {
    const key = seriesHash({ title: r.title, venue_name: r.venue_name, source: r.source });
    let g = byHash.get(key);
    if (!g) {
      g = {
        series: {
          title: r.title,
          description: r.description ?? null,
          category: r.category ?? "show",
          language: r.language ?? "es",
          audience: r.audience ?? "family",
          recurrence_kind: "sessions",
          venue_name: r.venue_name ?? null,
          district: r.district ?? null,
          address: r.address ?? null,
          city: r.city ?? "Valencia",
          country: r.country ?? "Spain",
          price: r.price ?? null,
          is_free: r.is_free ?? null,
          url: r.url ?? null,
          venue_url: r.venue_url ?? null,
          image_url: r.image_url ?? null,
          source: r.source,
          source_url: r.source_url ?? r.url ?? null,
          external_ref: r.external_ref ?? null,
          raw_excerpt: r.raw_excerpt ?? r.description ?? null,
        },
        occurrences: [],
        memberIds: [],
        days: [],
        score: null,
      };
      byHash.set(key, g);
    }
    // backfill a poster / description if the first row lacked one
    if (!g.series.image_url && r.image_url) g.series.image_url = r.image_url;
    if (!g.series.description && r.description) g.series.description = r.description;
    // series.score = max of members (idempotent: deterministic over the same input)
    const sc = r.score == null ? null : Number(r.score);
    if (sc != null && (g.score == null || sc > g.score)) g.score = sc;

    if (r.start_date) g.days.push(r.start_date);
    g.occurrences.push({
      occurrence_date: r.start_date || "",
      start_time: r.start_time ?? null,
      end_time: r.end_time ?? null,
      source_item_id: r.source_item_id ?? null,
      metadata_json: r.metadata_json ?? null,
    });
    g.memberIds.push(r.id);
  }

  const out = [];
  for (const g of byHash.values()) {
    const dated = g.days.filter(Boolean).sort();
    g.series.start_date = dated[0] ?? null;
    g.series.end_date = dated[dated.length - 1] ?? null;
    g.series.score = g.score;
    // keep ALL occurrences (every member event becomes one occurrence); drop only
    // truly date-less ones (can't be placed on the calendar) — none in this seed.
    g.occurrences = g.occurrences.filter((o) => o.occurrence_date);
    out.push(g);
  }
  return out;
}

async function main() {
  const rows = await sql`
    SELECT id, title, description, category, language, audience, start_date, start_time,
           end_time, venue_name, district, address, city, country, price, is_free, url,
           venue_url, image_url, source, source_url, external_ref, raw_excerpt,
           source_item_id, metadata_json, score, status
    FROM events
    WHERE source = ${HEMISFERIC_SOURCE_KEY}
    ORDER BY title, start_date, start_time
  `;
  console.log(`source events (source=${HEMISFERIC_SOURCE_KEY}): ${rows.length}`);

  const groups = groupHemisfericEvents(rows);
  console.log(`grouped into ${groups.length} series`);

  let seriesInserted = 0;
  let seriesUpdated = 0;
  let occurrencesUpserted = 0;
  let eventsMarked = 0;

  for (const g of groups) {
    const res = await upsertSeries(g.series, g.occurrences, { exec: sql });
    if (res.seriesInserted) seriesInserted++;
    else seriesUpdated++;
    occurrencesUpserted += res.occurrences;

    // upsertSeries deliberately never writes `score` (it must not reset downstream
    // scoring state on a re-ingest). For the migration we seed the series score = max
    // of its member events, but ONLY when the series score is still NULL — so a later
    // scoring pass is preserved and the migration stays idempotent.
    if (g.series.score != null) {
      await sql`
        UPDATE event_series
        SET score = ${g.series.score}
        WHERE id = ${res.seriesId} AND score IS NULL
      `;
    }

    // Supersede the member events so the feed query drops them. IDEMPOTENT: re-running
    // re-marks already-'duplicate' rows with the same series id (harmless). We merge the
    // marker into the existing metadata_json (JSON) rather than overwriting it, so the
    // session_times audit blob survives. Append-only: rows are never deleted.
    for (const id of g.memberIds) {
      await sql`
        UPDATE events
        SET status = 'duplicate',
            metadata_json = (
              COALESCE(metadata_json::jsonb, '{}'::jsonb)
              || jsonb_build_object('merged_into_series', ${res.seriesId}::int)
            )::text,
            last_seen = ${nowIso()}
        WHERE id = ${id}
      `;
      eventsMarked++;
    }
  }

  const seriesCount = (await sql`SELECT count(*)::int n FROM event_series`)[0].n;
  const occCount = (await sql`SELECT count(*)::int n FROM event_occurrences`)[0].n;
  const stillUpcoming = (
    await sql`SELECT count(*)::int n FROM events WHERE source = ${HEMISFERIC_SOURCE_KEY} AND (status = 'upcoming' OR status IS NULL)`
  )[0].n;

  console.log(
    JSON.stringify(
      {
        ok: true,
        sourceEvents: rows.length,
        seriesInserted,
        seriesUpdated,
        occurrencesUpserted,
        eventsMarked,
        totals: { event_series: seriesCount, event_occurrences: occCount },
        hemisRowsStillInFeed: stillUpcoming,
      },
      null,
      2,
    ),
  );
}

// Only run when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

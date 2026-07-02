// Re-bake the prod seed from the live local DB (T173; the CANONICAL bake entry).
// Writes THREE files:
//
//   events.json             DERIVED events only (see the WHERE below) — dedup'd,
//                           dated, future-relevant, enriched.
//   event_series.json       NATIVE recurring series (Hemisfèric etc.), exported
//   event_occurrences.json  straight from event_series/event_occurrences.
//
// WHY native series (the production-critical gap this closed): the seed used to
// ship Hemisfèric as 104 LEGACY `api:hemisferic` event rows (a frozen showtime
// window) that `db:migrate:series` converted to series at db:setup — so a fresh
// prod deploy AFTER that window's last date rendered ZERO Hemisfèric until the
// first live cron. The live local DB's series (maintained by the hemisferic
// normalizer via upsertSeries) are the CURRENT schedule; the bake now ships them
// directly and events.json carries NO api:hemisferic rows at all.
// `db:migrate:series` stays in db:setup as a harmless no-op (0 source events).
//
// events.json = DERIVED events from the live main DB:
//     source <> 'api:hemisferic'    (hemisferic ships via the series files)
//     AND status = 'upcoming'       (excludes 'duplicate'/'filtered')
//     AND start_date IS NOT NULL    (0 null dates)
//     AND end >= today              (no past events in a fresh deploy)
//     AND id >= 25000               (excludes curated low-id rows that belong to
//                                    the separate curated files — feria 1001-1043,
//                                    logunespa 24737-24796, DroneArt 1101-1102;
//                                    the derived id range starts at 25171)
//   This set already reflects dedup, corrected dates/cities, the lacotorra
//   hybrid filter, and exposition end_dates. Curated events-*.json files are
//   NEVER touched here.
//
// series files = FUTURE-RELEVANT series (status 'upcoming'/NULL whose latest
//   occurrence >= today) + ALL occurrences of those series (recent-past
//   occurrence dates ship too — keeps upsertSeries hashes stable). Selection is
//   the PURE selectSeriesForExport (scripts/_seed-schema.mjs, unit-tested);
//   columns are schema-driven (resolveExportColumns — no excludes for either
//   table, T182), loaded by scripts/seed.mjs with bare ON CONFLICT DO NOTHING.
//
// Output defaults to data/seed-rebake/ (scratch); pass `--commit` (or
// `--out data/seed`) to write the real seed. READ-ONLY on the DB (SELECT only).
//
// Usage:
//   DATABASE_URL=postgresql://postgres:postgres@db.localtest.me:5432/main \
//     node --import tsx scripts/rebake-seed.mjs [--out <dir>] [--commit]

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { sql } from "../lib/db.ts";
import { resolveExportColumns, shape, selectSeriesForExport } from "./_seed-schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  let out = "data/seed-rebake";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a === "--commit") out = "data/seed"; // explicit opt-in to clobber curated seed
  }
  return { out };
}
const { out } = parseArgs(process.argv.slice(2));
const outDir = isAbsolute(out) ? out : join(repoRoot, out);
const clobbersSeed = outDir === join(repoRoot, "data", "seed");

// Floor for "derived" ids; curated low-id rows (feria/logunespa/DroneArt) live in
// separate files and must NOT be duplicated into events.json.
const DERIVED_ID_FLOOR = 25000;

async function run() {
  mkdirSync(outDir, { recursive: true });
  if (clobbersSeed) {
    console.warn("⚠ --commit/--out data/seed — this OVERWRITES the seed events.json + series files.");
  }

  // SCHEMA-DRIVEN columns (T182, F3): resolved off the LIVE schema so an additive
  // ALTER TABLE can't silently drop a new column from the re-baked seed.
  const EVENT_COLS = await resolveExportColumns(sql, "events");
  const SERIES_COLS = await resolveExportColumns(sql, "event_series");
  const OCC_COLS = await resolveExportColumns(sql, "event_occurrences");
  console.log(
    `  events: ${EVENT_COLS.length} cols · event_series: ${SERIES_COLS.length} cols · event_occurrences: ${OCC_COLS.length} cols (schema-driven)`,
  );

  // (1) DERIVED events from the live DB. READ-ONLY. ORDER BY id -> stable diffs.
  const colList = EVENT_COLS.map((c) => `"${c}"`).join(", ");
  const derived = await sql(
    `SELECT ${colList} FROM events
       WHERE source <> 'api:hemisferic'
         AND status = 'upcoming'
         AND start_date IS NOT NULL
         AND COALESCE(end_date, start_date) >= to_char(CURRENT_DATE, 'YYYY-MM-DD')
         AND id >= ${DERIVED_ID_FLOOR}
       ORDER BY id ASC`,
  );
  const events = derived.map((r) => shape(r, EVENT_COLS));

  // (2) NATIVE series: full tables, then the PURE future-relevant selection.
  const seriesColList = SERIES_COLS.map((c) => `"${c}"`).join(", ");
  const occColList = OCC_COLS.map((c) => `"${c}"`).join(", ");
  const allSeries = await sql(`SELECT ${seriesColList} FROM event_series ORDER BY id ASC`);
  const allOcc = await sql(`SELECT ${occColList} FROM event_occurrences ORDER BY id ASC`);
  const today = new Date().toISOString().slice(0, 10);
  const picked = selectSeriesForExport(allSeries, allOcc, today);
  const series = picked.series.map((r) => shape(r, SERIES_COLS));
  const occurrences = picked.occurrences.map((r) => shape(r, OCC_COLS));

  // --- integrity guards -------------------------------------------------------
  // Guard: no api:hemisferic rows may leak into events.json (they ship as series).
  const hemisLeak = events.filter((e) => e.source === "api:hemisferic").length;
  if (hemisLeak) {
    console.error(`${hemisLeak} api:hemisferic rows leaked into derived events — aborting.`);
    process.exit(1);
  }
  // Guard: 0 null start_date in events (seed policy).
  const nullDates = events.filter((e) => !e.start_date).length;
  if (nullDates) {
    console.error(`events set has ${nullDates} null start_date rows — aborting.`);
    process.exit(1);
  }
  // Guard: a bake that ships ZERO series is exactly the "Hemisfèric vanishes on a
  // fresh deploy" regression this file exists to prevent.
  if (!series.length) {
    console.error("0 future-relevant event_series — refusing to bake a series-less seed.");
    process.exit(1);
  }
  // Guard: every shipped occurrence is dated + references a shipped series (FK).
  const seriesIds = new Set(series.map((s) => s.id));
  const badOcc = occurrences.filter((o) => !o.occurrence_date || !seriesIds.has(o.series_id)).length;
  if (badOcc) {
    console.error(`${badOcc} occurrences undated or orphaned from the shipped series — aborting.`);
    process.exit(1);
  }

  const files = {
    "events.json": events,
    "event_series.json": series,
    "event_occurrences.json": occurrences,
  };
  for (const [file, rows] of Object.entries(files)) {
    writeFileSync(join(outDir, file), JSON.stringify(rows, null, 2) + "\n", "utf-8");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        out: outDir,
        events: events.length,
        series: series.length,
        occurrences: occurrences.length,
        lastOccurrence: occurrences.reduce(
          (m, o) => (o.occurrence_date > m ? o.occurrence_date : m),
          "",
        ),
        nullDates,
      },
      null,
      2,
    ),
  );
}

run().catch((err) => {
  console.error("rebake-seed failed:", err?.message || err);
  process.exit(1);
});

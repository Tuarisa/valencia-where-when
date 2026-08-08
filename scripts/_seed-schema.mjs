// Schema-driven column sourcing for the seed exporter / re-baker (T182, F3).
//
// THE FOOTGUN this closes: the exporter used to build its SELECT + output object
// from a HARDCODED column list per table. This project does additive schema
// changes often (constitution: all schema changes additive, `ALTER TABLE … ADD
// COLUMN`). A new column was NEVER added to those hardcoded lists, so the next
// seed bake SILENTLY OMITTED it → prod shipped data missing the column, no error.
//
// FIX: derive each table's column set from the LIVE schema
// (information_schema.columns), so a freshly-added column is exported by default.
// Server-only/runtime-state columns are removed via an explicit EXCLUDE map (the
// loader re-seeds them), so the exclude is intentional + documented, while the
// base set tracks the schema.
//
// These helpers are PURE (no DB) except `fetchTableColumns`, so the column-list
// logic is unit-testable without a database.

// Columns deliberately NOT exported per table. The base set is derived from the
// live schema; anything here is subtracted. Document WHY each is excluded.
//
//   sources: the adaptive-cadence / conditional-GET / failure runtime state.
//     seed.mjs::seedCadence re-seeds min/max/poll interval + next_due_at from
//     per-type defaults on every db:setup, and etag/last_modified/fail_count etc.
//     are live polling state that must NOT ship baked into the seed. (Mirrors the
//     historical BASE-columns-only `sources.json` contract.)
export const EXPORT_EXCLUDES = {
  sources: [
    "poll_interval_sec",
    "min_interval_sec",
    "max_interval_sec",
    "next_due_at",
    "last_changed_at",
    "etag",
    "last_modified",
    "consecutive_unchanged",
    "observed_gap_sec",
    "fail_count",
  ],
};

// Given the FULL ordered column list for a table (schema order) and the table
// name, return the export column list = full set minus the documented excludes,
// preserving schema (ordinal) order so JSON diffs stay stable. PURE.
export function exportColumns(table, allColumns) {
  const excludes = new Set(EXPORT_EXCLUDES[table] || []);
  return allColumns.filter((c) => !excludes.has(c));
}

// Fetch a table's columns from the live schema in ordinal order. The result fed
// to exportColumns() yields the schema-driven export list. (DB round-trip.)
export async function fetchTableColumns(sql, table) {
  const rows = await sql(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

// Resolve the export column list for a table straight off the live schema. PURE
// helpers + one DB call; centralises the exclude policy for both scripts.
export async function resolveExportColumns(sql, table) {
  const all = await fetchTableColumns(sql, table);
  if (!all.length) {
    throw new Error(`table "${table}" has no columns in information_schema`);
  }
  return exportColumns(table, all);
}

// Build an ordered, stable-keyed object from a DB row for the given columns.
// Missing values normalise to null (matches the loader's null-coercion). PURE.
export function shape(row, cols) {
  const o = {};
  for (const c of cols) o[c] = row[c] === undefined ? null : row[c];
  return o;
}

// --- native event_series / event_occurrences seed ----------------------------
//
// The seed used to ship Hemisfèric as 104 LEGACY `api:hemisferic` event rows that
// `db:migrate:series` re-derived into series at db:setup — so a fresh prod deploy
// AFTER the last legacy showtime rendered ZERO Hemisfèric until the first live
// cron. The bake now ships `event_series.json` + `event_occurrences.json`
// NATIVELY (exported by scripts/rebake-seed.mjs — the canonical bake entry —
// loaded by scripts/seed.mjs). Neither table has EXPORT_EXCLUDES: the full
// schema-driven column set ships (incl. enrichment/score/notified — shipping
// baked state is the point).

// PURE: pick the FUTURE-RELEVANT series for the seed = status 'upcoming' (or
// NULL) whose LATEST occurrence is on/after `today`, plus ALL occurrences of
// those series (recent-past occurrence dates ship too — simpler, and keeps the
// upsertSeries dedup_hash identity stable on the first live re-ingest).
// `today` is 'YYYY-MM-DD'; date compares are lexicographic.
export function selectSeriesForExport(seriesRows, occurrenceRows, today) {
  const lastOcc = new Map();
  for (const o of occurrenceRows) {
    if (!o.occurrence_date) continue;
    const prev = lastOcc.get(o.series_id);
    if (!prev || o.occurrence_date > prev) lastOcc.set(o.series_id, o.occurrence_date);
  }
  const series = seriesRows.filter(
    (s) =>
      (s.status === "upcoming" || s.status == null) &&
      (lastOcc.get(s.id) || "") >= today,
  );
  const keep = new Set(series.map((s) => s.id));
  const occurrences = occurrenceRows.filter((o) => keep.has(o.series_id));
  return { series, occurrences };
}

// PURE: the seed loader's per-table conflict clause — bare `ON CONFLICT DO
// NOTHING` for EVERY table. Rationale: every content table carries TWO uniques
// (id pkey + dedup_hash), and a targeted ON CONFLICT (id) only absorbs its
// named constraint. That bit us twice: first event_series/occurrences (dual
// uniques at load), then — after T198 made PROD materialize events itself —
// the month-refresh db:setup crashed on events_dedup_hash_key: prod had created
// the SAME event (same dedup_hash) under its OWN sequence id, so the seed row
// conflicted on dedup_hash, not id. The seeder's semantic is "insert if absent,
// never touch live rows" — bare DO NOTHING is exactly that for any unique.
// Updates stay owned by the live pipeline (upsert*), never by the seeder.
export function seedConflictClause() {
  return "ON CONFLICT DO NOTHING";
}

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

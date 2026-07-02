// T182 (F3): the seed exporter sources its column list from the LIVE schema, not
// a hardcoded list, so an additive ALTER TABLE … ADD COLUMN can't silently drop a
// column from the baked prod seed. These tests cover the PURE column-list logic
// (no DB): exportColumns subtracts the documented EXPORT_EXCLUDES from a derived
// full set, preserves order, and — critically — INCLUDES a brand-new column.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_EXCLUDES,
  exportColumns,
  shape,
  selectSeriesForExport,
  seedConflictClause,
} from "../scripts/_seed-schema.mjs";

test("exportColumns: events has no excludes -> full set passes through unchanged", () => {
  const all = ["id", "title", "start_date", "score"];
  assert.deepEqual(exportColumns("events", all), all);
});

test("exportColumns: sources drops the documented cadence/etag/fail-count excludes", () => {
  const all = [
    "id", "key", "name", "type", "url", "lang", "enabled", "weight",
    "last_fetched", "notes",
    // runtime state that seed.mjs::seedCadence re-seeds — must NOT export:
    "poll_interval_sec", "min_interval_sec", "max_interval_sec", "next_due_at",
    "last_changed_at", "etag", "last_modified", "consecutive_unchanged",
    "observed_gap_sec", "fail_count",
  ];
  assert.deepEqual(exportColumns("sources", all), [
    "id", "key", "name", "type", "url", "lang", "enabled", "weight",
    "last_fetched", "notes",
  ]);
  // Every documented exclude is actually removed.
  for (const ex of EXPORT_EXCLUDES.sources) {
    assert.ok(!exportColumns("sources", all).includes(ex), `${ex} excluded`);
  }
});

test("exportColumns: a NEWLY-ADDED column is INCLUDED by default (drift fix)", () => {
  // Simulate an additive `ALTER TABLE events ADD COLUMN sentiment_score`.
  const all = ["id", "title", "start_date", "score", "sentiment_score"];
  const cols = exportColumns("events", all);
  assert.ok(
    cols.includes("sentiment_score"),
    "new column must flow into the export without touching the script",
  );
  // …and a new column on a table WITH excludes is still included.
  const srcAll = ["id", "key", "name", "fresh_col", "etag"];
  const srcCols = exportColumns("sources", srcAll);
  assert.ok(srcCols.includes("fresh_col"), "new sources column included");
  assert.ok(!srcCols.includes("etag"), "documented exclude still dropped");
});

test("exportColumns: preserves the input (ordinal) order", () => {
  const all = ["c", "a", "b"];
  assert.deepEqual(exportColumns("events", all), ["c", "a", "b"]);
});

test("exportColumns: unknown table -> no excludes, returns the full set", () => {
  const all = ["id", "x", "y"];
  assert.deepEqual(exportColumns("media_assets", all), all);
});

test("shape: orders keys by cols and null-coerces missing values", () => {
  const row = { b: 2, a: 1 };
  const out = shape(row, ["a", "b", "missing"]);
  assert.deepEqual(Object.keys(out), ["a", "b", "missing"]);
  assert.equal(out.missing, null);
  assert.equal(out.a, 1);
});

// --- native series seed (rebake-seed.mjs export + seed.mjs load) --------------

test("selectSeriesForExport: keeps upcoming/NULL-status series with an occurrence on/after today + ALL their occurrences", () => {
  const today = "2026-07-02";
  const series = [
    { id: 1, status: "upcoming" }, // future occurrence -> keep
    { id: 2, status: null }, // NULL status counts as upcoming -> keep
    { id: 3, status: "upcoming" }, // latest occurrence in the past -> drop
    { id: 4, status: "cancelled" }, // future occurrence but wrong status -> drop
    { id: 5, status: "upcoming" }, // no occurrences at all -> drop
  ];
  const occ = [
    { id: 10, series_id: 1, occurrence_date: "2026-06-20" }, // PAST occ of a kept series still ships
    { id: 11, series_id: 1, occurrence_date: "2026-07-15" },
    { id: 12, series_id: 2, occurrence_date: "2026-07-02" }, // today itself is future-relevant
    { id: 13, series_id: 3, occurrence_date: "2026-07-01" },
    { id: 14, series_id: 4, occurrence_date: "2026-08-01" },
    { id: 15, series_id: 3, occurrence_date: null }, // dateless never counts toward "latest"
  ];
  const out = selectSeriesForExport(series, occ, today);
  assert.deepEqual(out.series.map((s) => s.id), [1, 2]);
  assert.deepEqual(out.occurrences.map((o) => o.id), [10, 11, 12]);
});

test("selectSeriesForExport: empty inputs -> empty export (rebake guard then aborts)", () => {
  const out = selectSeriesForExport([], [], "2026-07-02");
  assert.deepEqual(out, { series: [], occurrences: [] });
});

test("seedConflictClause: series tables absorb ANY unique conflict (id + dedup_hash); others key on id", () => {
  assert.equal(seedConflictClause("event_series"), "ON CONFLICT DO NOTHING");
  assert.equal(seedConflictClause("event_occurrences"), "ON CONFLICT DO NOTHING");
  assert.equal(seedConflictClause("events"), "ON CONFLICT (id) DO NOTHING");
  assert.equal(seedConflictClause("sources"), "ON CONFLICT (id) DO NOTHING");
});

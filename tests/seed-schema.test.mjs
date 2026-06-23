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

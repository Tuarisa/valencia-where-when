import test from "node:test";
import assert from "node:assert/strict";
import {
  markEventsNotified,
  markPlacesNotified,
  markSeriesNotified,
} from "../lib/pipeline/notify.ts";

// The marking layer (lib/pipeline/notify.ts) had no direct test — only the pure selectors
// did. A code-review finding (F5) caught that the digest route built series into the
// payload but never marked them, so a real transport would repeat every series weekly
// (SC-002 violation). These tests pin the three mark helpers via an injectable `exec`
// (no DB): each must flip `notified` on its OWN table and log ONE notifications row keyed
// on the right column — markSeriesNotified on event_series + notifications.series_id.
//
// T184/F4 (batched writes): the helpers no longer do 2N per-row round-trips. Each call is
// now exactly TWO statements — ONE bulk UPDATE (id = ANY($ids)) touching all ids, and ONE
// bulk INSERT (SELECT * FROM unnest($ids, $stamps, $channels)) logging one row per id. The
// assertions below pin that batched form: same table, same notifications column, channel
// bound, all ids carried in a single array parameter, and empty input = no-op returning 0.

// A mock tagged-template `exec` that records each statement as { sql, values }.
function recordingExec() {
  const calls = [];
  const exec = (strings, ...values) => {
    calls.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return Promise.resolve([]);
  };
  return { exec, calls };
}

test("markSeriesNotified: batched UPDATE event_series + INSERT notifications.series_id (F4/F5)", async () => {
  const { exec, calls } = recordingExec();
  const n = await markSeriesNotified([7, 9], { exec, channel: "telegram" });
  assert.equal(n, 2);
  // Batched: exactly 2 statements total — ONE bulk UPDATE + ONE bulk INSERT (was 4).
  assert.equal(calls.length, 2);
  const updates = calls.filter((c) => /UPDATE event_series SET notified/.test(c.sql));
  const inserts = calls.filter((c) => /INSERT INTO notifications \(series_id/.test(c.sql));
  assert.equal(updates.length, 1, "one bulk UPDATE event_series touching all ids");
  assert.equal(inserts.length, 1, "one bulk INSERT notifications(series_id) for all ids");
  // The UPDATE targets all ids via a single array param (id = ANY($ids)).
  assert.match(updates[0].sql, /WHERE id = ANY\(\?\)/);
  assert.ok(
    updates[0].values.some((v) => Array.isArray(v) && v.length === 2 && v[0] === 7 && v[1] === 9),
    "UPDATE carries both ids in one array param",
  );
  // The INSERT carries all ids in one array param and binds the channel.
  assert.match(inserts[0].sql, /unnest/);
  assert.deepEqual(inserts[0].values[0], [7, 9], "INSERT carries both ids in one array param (first unnest arg)");
  assert.ok(
    inserts[0].values.some((v) => Array.isArray(v) && v.includes("telegram")),
    "channel bound (as a per-row array)",
  );
});

test("markEventsNotified / markPlacesNotified target their own tables, batched (symmetry)", async () => {
  const ev = recordingExec();
  await markEventsNotified([1, 2], { exec: ev.exec });
  assert.equal(ev.calls.length, 2, "events: 2 statements (1 UPDATE + 1 INSERT)");
  assert.ok(ev.calls.some((c) => /UPDATE events SET notified.*WHERE id = ANY\(\?\)/.test(c.sql)));
  assert.ok(ev.calls.some((c) => /INSERT INTO notifications \(event_id/.test(c.sql) && /unnest/.test(c.sql)));

  const pl = recordingExec();
  await markPlacesNotified([2, 3], { exec: pl.exec });
  assert.equal(pl.calls.length, 2, "places: 2 statements (1 UPDATE + 1 INSERT)");
  assert.ok(pl.calls.some((c) => /UPDATE places SET notified.*WHERE id = ANY\(\?\)/.test(c.sql)));
  assert.ok(pl.calls.some((c) => /INSERT INTO notifications \(place_id/.test(c.sql) && /unnest/.test(c.sql)));
});

test("mark helpers: empty id list is a no-op", async () => {
  const { exec, calls } = recordingExec();
  assert.equal(await markSeriesNotified([], { exec }), 0);
  assert.equal(calls.length, 0);
});

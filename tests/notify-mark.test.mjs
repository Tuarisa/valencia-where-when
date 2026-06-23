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

// A mock tagged-template `exec` that records each statement as { sql, values }.
function recordingExec() {
  const calls = [];
  const exec = (strings, ...values) => {
    calls.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return Promise.resolve([]);
  };
  return { exec, calls };
}

test("markSeriesNotified: updates event_series + logs notifications.series_id (F5)", async () => {
  const { exec, calls } = recordingExec();
  const n = await markSeriesNotified([7, 9], { exec, channel: "telegram" });
  assert.equal(n, 2);
  // 2 ids × (UPDATE + INSERT) = 4 statements
  assert.equal(calls.length, 4);
  const updates = calls.filter((c) => /UPDATE event_series SET notified/.test(c.sql));
  const inserts = calls.filter((c) => /INSERT INTO notifications \(series_id/.test(c.sql));
  assert.equal(updates.length, 2, "one UPDATE event_series per id");
  assert.equal(inserts.length, 2, "one notifications(series_id) row per id");
  // ids and channel are bound as parameters
  assert.deepEqual(inserts[0].values.slice(0, 1), [7]);
  assert.ok(inserts[0].values.includes("telegram"), "channel bound");
});

test("markEventsNotified / markPlacesNotified target their own tables (symmetry)", async () => {
  const ev = recordingExec();
  await markEventsNotified([1], { exec: ev.exec });
  assert.ok(ev.calls.some((c) => /UPDATE events SET notified/.test(c.sql)));
  assert.ok(ev.calls.some((c) => /INSERT INTO notifications \(event_id/.test(c.sql)));

  const pl = recordingExec();
  await markPlacesNotified([2], { exec: pl.exec });
  assert.ok(pl.calls.some((c) => /UPDATE places SET notified/.test(c.sql)));
  assert.ok(pl.calls.some((c) => /INSERT INTO notifications \(place_id/.test(c.sql)));
});

test("mark helpers: empty id list is a no-op", async () => {
  const { exec, calls } = recordingExec();
  assert.equal(await markSeriesNotified([], { exec }), 0);
  assert.equal(calls.length, 0);
});

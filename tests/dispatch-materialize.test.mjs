import test from "node:test";
import assert from "node:assert/strict";

// T198 — the dispatch tick materializes events (normalize → dedup → score + tag)
// after ingesting. These tests exercise the REAL `materializeTick` from
// lib/pipeline/dispatcher.ts (tsx loader resolves the TS import, same as the
// normalizer tests) with FULLY INJECTED deps — registry, stage fns and clock —
// so no DB connection is ever opened.
//
// Background (why this exists): a month of autonomous prod running showed the
// */15 cron only INGESTED — 5406 pending raw source_items accumulated and 0
// events were ever created. The tick must now also normalize (bounded to the
// sources just ingested), dedup and score+tag, fail-soft, under a soft deadline.

// T200 — a 2026-08-07 prod tick 504'd at the 60s Hobby limit DESPITE the 45s soft
// budget: only materialize was budget-gated, the ingest pool that runs FIRST had no
// deadline at all. The whole tick now shares one deadline: `runIngestPool` defers
// (never starts) sources past it, and `dispatch` surfaces the deferral + reports
// "ingest" as the cut stage. Same fully-injected style — fake ingestFn, fake clock.

import { materializeTick, runIngestPool, dispatch, isIngestOnly, DEFAULT_BUDGET_MS } from "../lib/pipeline/dispatcher";

// A deps bundle with call-recording stage fns and a controllable clock.
function makeDeps({ registry, nowFn } = {}) {
  const calls = { dedup: 0, score: 0, tag: 0 };
  return {
    calls,
    deps: {
      registry: registry ?? new Map(),
      dedupFn: async () => { calls.dedup++; return { groups: 1, merged: 2, collapsed: 3, provenanceRows: 0 }; },
      scoreFn: async () => { calls.score++; return { scored: 7 }; },
      tagFn: async () => { calls.tag++; return { events: 7, places: 2 }; },
      now: nowFn ?? (() => 0),
    },
  };
}

const FAR_DEADLINE = 1_000_000; // with the default fake clock at 0, never exhausted

test("normalize runs ONLY for ingested + registered sources; unregistered are skipped", async () => {
  const ran = [];
  const registry = new Map([
    ["web:a", async () => { ran.push("web:a"); return { created: 2, updated: 1, processed: 3 }; }],
    ["web:b", async () => { ran.push("web:b"); return { created: 0, updated: 0, processed: 0 }; }],
  ]);
  const { deps, calls } = makeDeps({ registry });

  // "web:b" is registered but was NOT ingested this tick → must not run.
  const res = await materializeTick(["web:a", "web:unknown"], FAR_DEADLINE, deps);

  assert.deepEqual(ran, ["web:a"], "only the ingested+registered source normalizes");
  assert.deepEqual(res.normalize.sources, ["web:a"]);
  assert.deepEqual(res.normalize.skipped, ["web:unknown"]);
  assert.deepEqual(res.normalize.deferred, []);
  assert.equal(res.normalize.created, 2);
  assert.equal(res.normalize.updated, 1);
  assert.equal(res.normalize.processed, 3);
  // Downstream stages ran exactly once each.
  assert.deepEqual(calls, { dedup: 1, score: 1, tag: 1 });
  assert.deepEqual(res.dedup, { groups: 1, merged: 2, collapsed: 3, provenanceRows: 0 });
  assert.deepEqual(res.score, { scored: 7 });
  assert.deepEqual(res.tag, { events: 7, places: 2 });
  assert.equal(res.budgetExhausted, false);
  assert.equal(res.cutAt, null);
  assert.deepEqual(res.errors, {});
});

test("duplicate ingested keys collapse — a normalizer runs at most once per tick", async () => {
  let runs = 0;
  const registry = new Map([
    ["web:a", async () => { runs++; return { created: 1, updated: 0, processed: 1 }; }],
  ]);
  const { deps } = makeDeps({ registry });

  const res = await materializeTick(["web:a", "web:a", "web:a"], FAR_DEADLINE, deps);
  assert.equal(runs, 1);
  assert.equal(res.normalize.created, 1);
});

test("a throwing normalizer does NOT break the tick (fail-soft): siblings + later stages still run", async () => {
  const ran = [];
  const registry = new Map([
    ["web:boom", async () => { throw new Error("parser exploded"); }],
    ["web:ok", async () => { ran.push("web:ok"); return { created: 5, updated: 0, processed: 5 }; }],
  ]);
  const { deps, calls } = makeDeps({ registry });

  const res = await materializeTick(["web:boom", "web:ok"], FAR_DEADLINE, deps);

  assert.deepEqual(ran, ["web:ok"], "sibling normalizer still ran after the throw");
  assert.equal(res.normalize.errors.length, 1);
  assert.equal(res.normalize.errors[0].source, "web:boom");
  assert.match(res.normalize.errors[0].error, /parser exploded/);
  assert.equal(res.normalize.created, 5, "counts from the healthy source survive");
  assert.deepEqual(calls, { dedup: 1, score: 1, tag: 1 }, "dedup/score/tag unaffected");
  assert.equal(res.budgetExhausted, false);
});

test("a throwing dedup is fail-soft: error recorded, score + tag still run", async () => {
  const { deps, calls } = makeDeps({});
  deps.dedupFn = async () => { throw new Error("dedup sql down"); };

  const res = await materializeTick([], FAR_DEADLINE, deps);

  assert.equal(res.dedup, null);
  assert.match(res.errors.dedup, /dedup sql down/);
  assert.deepEqual(res.score, { scored: 7 });
  assert.deepEqual(res.tag, { events: 7, places: 2 });
  assert.equal(calls.score, 1);
  assert.equal(calls.tag, 1);
  assert.equal(res.budgetExhausted, false, "an error is not a budget cut");
});

test("deadline already spent → every stage skipped, registered sources deferred, cutAt=normalize", async () => {
  let runs = 0;
  const registry = new Map([
    ["web:a", async () => { runs++; return { created: 1, updated: 0, processed: 1 }; }],
  ]);
  // Clock starts AT the deadline → over budget before anything starts.
  const { deps, calls } = makeDeps({ registry, nowFn: () => 100 });

  const res = await materializeTick(["web:a", "web:unregistered"], /*deadline*/ 100, deps);

  assert.equal(runs, 0, "no normalizer invoked");
  assert.deepEqual(res.normalize.deferred, ["web:a"], "registered work carried to the next tick");
  assert.deepEqual(res.normalize.skipped, ["web:unregistered"]);
  assert.deepEqual(calls, { dedup: 0, score: 0, tag: 0 }, "no later stage invoked");
  assert.equal(res.dedup, null);
  assert.equal(res.score, null);
  assert.equal(res.tag, null);
  assert.equal(res.budgetExhausted, true);
  assert.equal(res.cutAt, "normalize", "first stage hit by the budget");
});

test("budget spent MID-normalize → remaining sources deferred, later stages skipped", async () => {
  let t = 0;
  const ran = [];
  const registry = new Map([
    // First normalizer eats the whole budget.
    ["web:slow", async () => { ran.push("web:slow"); t = 10_000; return { created: 1, updated: 0, processed: 1 }; }],
    ["web:next", async () => { ran.push("web:next"); return { created: 1, updated: 0, processed: 1 }; }],
  ]);
  const { deps, calls } = makeDeps({ registry, nowFn: () => t });

  const res = await materializeTick(["web:slow", "web:next"], /*deadline*/ 5_000, deps);

  assert.deepEqual(ran, ["web:slow"], "second source not started past the deadline");
  assert.deepEqual(res.normalize.sources, ["web:slow"]);
  assert.deepEqual(res.normalize.deferred, ["web:next"]);
  assert.deepEqual(calls, { dedup: 0, score: 0, tag: 0 });
  assert.equal(res.budgetExhausted, true);
  assert.equal(res.cutAt, "normalize");
});

test("budget spent AFTER normalize → normalize kept, dedup/score/tag skipped, cutAt=dedup", async () => {
  let t = 0;
  const registry = new Map([
    ["web:a", async () => { t = 6_000; return { created: 3, updated: 0, processed: 3 }; }],
  ]);
  const { deps, calls } = makeDeps({ registry, nowFn: () => t });

  const res = await materializeTick(["web:a"], /*deadline*/ 5_000, deps);

  assert.deepEqual(res.normalize.sources, ["web:a"], "normalize completed before the cut");
  assert.equal(res.normalize.created, 3);
  assert.deepEqual(calls, { dedup: 0, score: 0, tag: 0 });
  assert.equal(res.cutAt, "dedup");
  assert.equal(res.budgetExhausted, true);
});

test("budget spent between score and tag → cutAt=tag, score result kept", async () => {
  let t = 0;
  const { deps, calls } = makeDeps({ nowFn: () => t });
  deps.scoreFn = async () => { calls.score++; t = 9_000; return { scored: 4 }; };

  const res = await materializeTick([], /*deadline*/ 5_000, deps);

  assert.equal(calls.dedup, 1);
  assert.equal(calls.score, 1);
  assert.equal(calls.tag, 0, "tag skipped once the budget is spent");
  assert.deepEqual(res.score, { scored: 4 });
  assert.equal(res.tag, null);
  assert.equal(res.cutAt, "tag");
  assert.equal(res.budgetExhausted, true);
});

test("default soft budget leaves headroom under the route's maxDuration=60s", () => {
  assert.equal(DEFAULT_BUDGET_MS, 45_000);
});

// ---------------------------------------------------------------------------
// T200 — the ingest pool shares the tick deadline
// ---------------------------------------------------------------------------

test("ingest pool: budget holds → every source ingested in batch order, nothing deferred", async () => {
  const started = [];
  const pool = await runIngestPool(
    [{ key: "web:a" }, { key: "web:b" }, { key: "web:c" }],
    2,
    FAR_DEADLINE,
    {
      ingestFn: async (s) => { started.push(s.key); return { source: s.key, status: "ok", items: 1, newItems: 1 }; },
      now: () => 0,
    },
  );
  assert.deepEqual(started, ["web:a", "web:b", "web:c"]);
  assert.deepEqual(pool.deferred, []);
  assert.equal(pool.results.length, 3);
  assert.ok(pool.results.every((r) => r.status === "ok"));
});

test("ingest pool: deadline passes MID-pool → later batches never start, sources deferred", async () => {
  let t = 0;
  const started = [];
  const sources = ["web:a", "web:b", "web:c", "web:d", "web:e"].map((key) => ({ key }));
  const pool = await runIngestPool(sources, 2, /*deadline*/ 5_000, {
    // First batch (a+b) eats the whole budget — e.g. a slow host riding its 30s abort.
    ingestFn: async (s) => { started.push(s.key); t = 10_000; return { source: s.key, status: "ok", items: 0, newItems: 0 }; },
    now: () => t,
  });
  assert.deepEqual(started, ["web:a", "web:b"], "no batch STARTS past the deadline");
  assert.deepEqual(pool.deferred, ["web:c", "web:d", "web:e"], "un-started due sources carried to the next tick");
  assert.equal(pool.results.length, 2, "only started sources report outcomes");
});

test("ingest pool: deadline already spent at start → all sources deferred, zero fetches", async () => {
  let calls = 0;
  const pool = await runIngestPool([{ key: "web:a" }, { key: "web:b" }], 5, /*deadline*/ 100, {
    ingestFn: async (s) => { calls++; return { source: s.key, status: "ok" }; },
    now: () => 100,
  });
  assert.equal(calls, 0, "no fetch started");
  assert.deepEqual(pool.deferred, ["web:a", "web:b"]);
  assert.deepEqual(pool.results, []);
});

test("ingest pool: a rejecting source becomes an error outcome (fail-soft), siblings unaffected", async () => {
  const pool = await runIngestPool([{ key: "web:boom" }, { key: "web:ok" }], 5, FAR_DEADLINE, {
    ingestFn: async (s) => {
      if (s.key === "web:boom") throw new Error("dns melted");
      return { source: s.key, status: "ok", items: 2, newItems: 1 };
    },
    now: () => 0,
  });
  assert.equal(pool.results.length, 2);
  const boom = pool.results.find((r) => r.source === "web:boom");
  assert.equal(boom.status, "error");
  assert.match(boom.error, /dns melted/);
  assert.deepEqual(pool.deferred, [], "an error is not a deferral — cadence back-off handles it");
});

test("dispatch: ingest deferral surfaces in the result — deferred keys, budget.cutAt='ingest'", async () => {
  let t = 0;
  const { deps } = makeDeps({ nowFn: () => t });
  const res = await dispatch({
    concurrency: 1,
    budgetMs: 5_000,
    deps: {
      ...deps,
      sourcesFn: async () => ["web:a", "web:b", "web:c"].map((key) => ({ key })),
      // Each source burns 4s: a ends t=4s (<5s → b starts), b ends t=8s (≥5s → c deferred).
      ingestFn: async (s) => { t += 4_000; return { source: s.key, status: "ok", items: 1, newItems: 1 }; },
    },
  });
  assert.deepEqual(res.deferred, ["web:c"], "the response carries the deferred source keys");
  assert.equal(res.total, 2, "deferred sources have no outcome row");
  assert.equal(res.okCount, 2);
  assert.equal(res.budget.exhausted, true);
  assert.equal(res.budget.cutAt, "ingest", "ingest is the FIRST stage the budget hit");
  // Materialize still ran fail-soft — with the budget already spent it did no work.
  assert.equal(res.materialize.budgetExhausted, true);
  assert.deepEqual(res.materialize.normalize.skipped, ["web:a", "web:b"], "empty registry → ingested keys skipped");
});

test("dispatch: within budget → no deferral, budget not exhausted, cutAt null", async () => {
  const { deps, calls } = makeDeps({ nowFn: () => 0 });
  const res = await dispatch({
    budgetMs: 5_000,
    deps: {
      ...deps,
      sourcesFn: async () => [{ key: "web:a" }],
      ingestFn: async (s) => ({ source: s.key, status: "ok", items: 3, newItems: 2 }),
    },
  });
  assert.deepEqual(res.deferred, []);
  assert.equal(res.total, 1);
  assert.equal(res.items, 3);
  assert.equal(res.budget.exhausted, false);
  assert.equal(res.budget.cutAt, null);
  assert.deepEqual(calls, { dedup: 1, score: 1, tag: 1 }, "materialize ran normally");
});

test("isIngestOnly: DISPATCH_INGEST_ONLY=1 short-circuits materialization; anything else does not", () => {
  assert.equal(isIngestOnly({ DISPATCH_INGEST_ONLY: "1" }), true);
  assert.equal(isIngestOnly({ DISPATCH_INGEST_ONLY: "0" }), false);
  assert.equal(isIngestOnly({ DISPATCH_INGEST_ONLY: "" }), false);
  assert.equal(isIngestOnly({}), false);
  assert.equal(isIngestOnly({ DISPATCH_INGEST_ONLY: "true" }), false, "only the literal '1' opts out");
});

import { sql } from "../db";
import { nowIso } from "./util";
import { ingestSource, IngestOutcome } from "./ingest";
import {
  cadenceDefaults,
  computePollInterval,
  backoffUnchanged,
  backoffError,
  nextDueIso,
  selectDue,
} from "./cadence";
import { NORMALIZER_REGISTRY, resolveNormalizer, type SourceNormalizer } from "./normalize";
import { dedup } from "./dedup";
import { scoreAll } from "./score";
import { tagAll } from "./tags";

// Adaptive ingest dispatcher (sub-area A, research A6). The */15 scheduler tick POSTs
// /api/cron/dispatch → dispatch(), which polls only the sources whose per-source
// cadence says they're DUE, with a bounded concurrency pool, then writes each source's
// cadence state back (next due time, back-off counters, observed change gap).
//
// ingestAll() (force-all, legacy) stays in ingest.ts untouched; dispatch({force:true})
// is the adaptive equivalent that ignores due-times but still updates cadence.
//
// T198 — the tick MATERIALIZES events, not just raw rows. PROD GAP found 2026-08-07
// after a month of autonomous running: dispatch only ingested, so prod accumulated
// 5406 pending `source_items` and created 0 events — the site only gained events via
// the manual local bake. Each tick now also runs, fail-soft and under a soft time
// budget: normalize (ONLY the sources just ingested) → dedup → score + tag.
// See materializeTick() below for the stage-by-stage reasoning.

export async function selectDueSources(nowIsoArg?: string): Promise<any[]> {
  const now = nowIsoArg ?? nowIso();
  const sources = (await sql`SELECT * FROM sources WHERE enabled = 1`) as any[];
  return selectDue(sources, now);
}

function gapSecondsSince(prevIso: string | null | undefined, nowIso: string): number | null {
  if (!prevIso) return null;
  const prev = Date.parse(prevIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(prev) || Number.isNaN(now)) return null;
  const gap = Math.round((now - prev) / 1000);
  return gap > 0 ? gap : null;
}

// Translate one ingest outcome into the source's next cadence state and persist it.
// Bounds are the source's stored min/max, falling back to per-type defaults.
async function applyCadence(source: any, outcome: IngestOutcome): Promise<void> {
  const now = nowIso();
  const nowMs = Date.now();
  const defaults = cadenceDefaults(source.type);
  const min = source.min_interval_sec ?? defaults.min;
  const max = source.max_interval_sec ?? defaults.max;

  let poll: number;
  let failCount = source.fail_count ?? 0;
  let consecutiveUnchanged = source.consecutive_unchanged ?? 0;
  let lastChangedAt: string | null = source.last_changed_at ?? null;
  let observedGap: number | null = source.observed_gap_sec ?? null;

  if (outcome.status === "error") {
    failCount = failCount + 1;
    poll = backoffError(min, failCount, max);
  } else if (outcome.notModified || (outcome.newItems ?? 0) === 0) {
    // 304 or fetched-but-no-new-items: relax via ×1.5 back-off.
    failCount = 0;
    consecutiveUnchanged = consecutiveUnchanged + 1;
    poll = backoffUnchanged(min, consecutiveUnchanged, max);
  } else {
    // Changed: reset counters, record the observed gap between changes, relax toward it.
    failCount = 0;
    consecutiveUnchanged = 0;
    const gap = gapSecondsSince(lastChangedAt, now);
    if (gap != null) observedGap = gap;
    lastChangedAt = now;
    poll = computePollInterval({ observedGapSec: observedGap, minIntervalSec: min, maxIntervalSec: max });
  }

  const nextDue = nextDueIso(nowMs, poll);
  await sql`UPDATE sources SET
    poll_interval_sec = ${poll},
    next_due_at = ${nextDue},
    fail_count = ${failCount},
    consecutive_unchanged = ${consecutiveUnchanged},
    last_changed_at = ${lastChangedAt},
    observed_gap_sec = ${observedGap}
    WHERE key = ${source.key}`;
}

// ---------------------------------------------------------------------------
// T198 — per-tick materialization (normalize → dedup → score + tag)
// ---------------------------------------------------------------------------
//
// Why draining a source's FULL pending backlog in one tick is acceptable: a
// registered normalizer processes ALL pending `source_items` rows for its source,
// but normalizers are pure JS over already-fetched raw text/html — no network, no
// LLM (the expensive stages were only ever fetch + claude). Hundreds to low
// thousands of rows parse in milliseconds, so even the month-scale prod backlog
// (5406 rows across ~27 sources) clears source-by-source as each comes due, and
// the 45s soft budget is the safety net: anything cut off simply stays `pending`
// and completes on a later tick (every stage is idempotent).
//
// Deliberately NOT run in the tick (would blow the Hobby 60s budget / AI-less prod):
//   - geo: Nominatim is network-bound and politeness-rate-limited (~1 req/s) —
//     geocoding stays in the local bake (T157) / a dedicated slow path.
//   - enrich: prod has no AI engine (T162); RU enrichment is the local `claude -p`
//     bake ritual (T195).

// Escape hatch: DISPATCH_INGEST_ONLY=1 restores the historical ingest-only tick
// (documented in .env.example). Pure + injectable so tests need no process.env.
export function isIngestOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env.DISPATCH_INGEST_ONLY === "1";
}

// Soft time budget: leave ~15s headroom under the route's maxDuration=60 so an
// in-flight stage can finish and the response still gets out.
export const DEFAULT_BUDGET_MS = 45_000;

export interface MaterializeDeps {
  registry?: Map<string, SourceNormalizer>;
  dedupFn?: () => Promise<unknown>;
  scoreFn?: () => Promise<unknown>;
  tagFn?: () => Promise<unknown>;
  now?: () => number;
}

export interface NormalizeTickSummary {
  sources: string[];  // ingested + registered → normalizer ran this tick
  skipped: string[];  // ingested but no registered normalizer (raw stays pending/ignored)
  deferred: string[]; // registered but cut by the time budget → next tick (idempotent)
  created: number;
  updated: number;
  processed: number;
  errors: Array<{ source: string; error: string }>;
}

export interface MaterializeResult {
  normalize: NormalizeTickSummary;
  dedup: unknown | null; // null = stage did not run (budget) — see cutAt
  score: unknown | null;
  tag: unknown | null;
  errors: { dedup?: string; score?: string; tag?: string };
  budgetExhausted: boolean;
  cutAt: "normalize" | "dedup" | "score" | "tag" | null; // first stage hit by the budget
}

// Run the post-ingest materialization stages for one tick. Bounded: normalize is
// restricted to the source keys actually ingested this tick; dedup is O(upcoming
// events) SQL+JS; score/tag are batched single-statement writes (T184). Every
// stage is fail-soft (its own try/catch) and gated on a Date.now() deadline check
// so a slow stage never starts with the budget already spent. All deps are
// injectable — unit-testable without a DB.
export async function materializeTick(
  ingestedKeys: string[],
  deadlineMs: number,
  deps: MaterializeDeps = {},
): Promise<MaterializeResult> {
  const registry = deps.registry ?? NORMALIZER_REGISTRY;
  const runDedup = deps.dedupFn ?? (() => dedup());
  const runScore = deps.scoreFn ?? (() => scoreAll());
  const runTag = deps.tagFn ?? (() => tagAll());
  const now = deps.now ?? Date.now;

  const result: MaterializeResult = {
    normalize: { sources: [], skipped: [], deferred: [], created: 0, updated: 0, processed: 0, errors: [] },
    dedup: null,
    score: null,
    tag: null,
    errors: {},
    budgetExhausted: false,
    cutAt: null,
  };

  const overBudget = (stage: NonNullable<MaterializeResult["cutAt"]>): boolean => {
    if (now() < deadlineMs) return false;
    result.budgetExhausted = true;
    if (result.cutAt == null) result.cutAt = stage;
    return true;
  };

  // Stage 1: normalize ONLY the sources ingested this tick. A registered
  // normalizer drains ALL pending rows for its source (incl. earlier-tick
  // backlog — see the CPU-light reasoning above). Deadline-checked per source;
  // a thrown normalizer never aborts the tick.
  for (const key of Array.from(new Set(ingestedKeys))) {
    const normalizer = resolveNormalizer(key, registry);
    if (!normalizer) {
      result.normalize.skipped.push(key);
      continue;
    }
    if (overBudget("normalize")) {
      result.normalize.deferred.push(key);
      continue;
    }
    try {
      const res = await normalizer();
      result.normalize.sources.push(key);
      result.normalize.created += res.created;
      result.normalize.updated += res.updated;
      result.normalize.processed += res.processed;
    } catch (err: any) {
      result.normalize.errors.push({ source: key, error: String(err?.message ?? err) });
    }
  }

  // Stage 2: dedup — O(upcoming events) SQL + JS, seconds at prod scale.
  if (!overBudget("dedup")) {
    try {
      result.dedup = await runDedup();
    } catch (err: any) {
      result.errors.dedup = String(err?.message ?? err);
    }
  }

  // Stage 3: score + tag — batched O(1)-statement writes (T184).
  if (!overBudget("score")) {
    try {
      result.score = await runScore();
    } catch (err: any) {
      result.errors.score = String(err?.message ?? err);
    }
  }
  if (!overBudget("tag")) {
    try {
      result.tag = await runTag();
    } catch (err: any) {
      result.errors.tag = String(err?.message ?? err);
    }
  }

  // NOT run: geo (Nominatim latency) and enrich (AI-less prod) — see header note.
  return result;
}

// T200 — ingest pool deps, injectable like MaterializeDeps so the pool's deadline
// behavior is unit-testable without a DB. The real `ingestFn` is ingestSource +
// applyCadence (composed in runIngestPool's default).
export interface IngestPoolDeps {
  ingestFn?: (source: any, deadlineMs: number) => Promise<IngestOutcome>;
  now?: () => number;
}

export interface IngestPoolResult {
  results: IngestOutcome[];
  deferred: string[]; // due sources whose fetch never STARTED — budget spent (T200)
}

// Bounded pool: process sources `concurrency` at a time via Promise.allSettled,
// ingesting then persisting cadence per source. Fail-soft — a thrown source never
// aborts the batch.
//
// T200 — the pool is gated on the SHARED tick deadline (the 2026-08-07 prod 504:
// the 45s budget only guarded materialize, so ingest alone could eat the 60s Hobby
// limit before a single check fired). A batch never STARTS once the budget is spent
// (same deadline-before-start contract as materializeTick's stage gate); un-started
// sources come back as `deferred` with their cadence UNTOUCHED — still due, so the
// next tick picks them up. Ingest is idempotent upserts, so deferral loses nothing.
export async function runIngestPool(
  sources: any[],
  concurrency: number,
  deadlineMs: number,
  deps: IngestPoolDeps = {},
): Promise<IngestPoolResult> {
  const now = deps.now ?? Date.now;
  const ingest =
    deps.ingestFn ??
    (async (source: any, dl: number) => {
      // minIntervalHours=0 → bypass the legacy time guard; the cadence due-select
      // already decided this source should run.
      const outcome = await ingestSource(source, 0, dl);
      await applyCadence(source, outcome);
      return outcome;
    });

  const results: IngestOutcome[] = [];
  const deferred: string[] = [];
  const size = Math.max(1, concurrency);
  for (let i = 0; i < sources.length; i += size) {
    if (now() >= deadlineMs) {
      for (const s of sources.slice(i)) deferred.push(s.key);
      break;
    }
    const batch = sources.slice(i, i + size);
    const settled = await Promise.allSettled(batch.map((source) => ingest(source, deadlineMs)));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === "fulfilled") {
        results.push(s.value);
      } else {
        results.push({ source: batch[j]?.key ?? "unknown", status: "error", error: String(s.reason) });
      }
    }
  }
  return { results, deferred };
}

// Everything dispatch() delegates to is injectable (tests: no DB): the ingest pool,
// the materialize stages, the clock, and (T200) the due-source selection itself.
export interface DispatchDeps extends MaterializeDeps, IngestPoolDeps {
  sourcesFn?: (force: boolean) => Promise<any[]>;
}

export interface DispatchResult {
  ok: boolean;
  total: number;
  okCount: number;
  error: number;
  items: number;
  results: IngestOutcome[];
  deferred: string[]; // T200: due sources never started this tick (budget) — still due next tick
  ingestOnly: boolean; // true ⇢ DISPATCH_INGEST_ONLY=1 restored the legacy behavior
  materialize: MaterializeResult | null; // null when ingest-only
  budget: { budgetMs: number; elapsedMs: number; exhausted: boolean; cutAt: string | null };
}

// One tick: ingest due (or all-enabled when force) sources through the bounded pool,
// then materialize (normalize → dedup → score + tag; T198) unless DISPATCH_INGEST_ONLY=1.
// T200: the WHOLE tick shares ONE deadline computed here — the pool defers un-started
// sources past it, ingestSource clamps its fetch timeouts to it, and materializeTick
// gates every stage on it.
export async function dispatch({
  concurrency = 5,
  force = false,
  budgetMs = DEFAULT_BUDGET_MS,
  deps,
}: {
  concurrency?: number;
  force?: boolean;
  budgetMs?: number;
  deps?: DispatchDeps;
} = {}): Promise<DispatchResult> {
  const clock = deps?.now ?? Date.now;
  const startedMs = clock();
  const deadlineMs = startedMs + budgetMs;
  const now = nowIso();
  const sources = deps?.sourcesFn
    ? await deps.sourcesFn(force)
    : force
      ? ((await sql`SELECT * FROM sources WHERE enabled = 1`) as any[])
      : await selectDueSources(now);

  const pool = await runIngestPool(sources, concurrency, deadlineMs, {
    ingestFn: deps?.ingestFn,
    now: deps?.now,
  });
  const results = pool.results;

  // T198: materialize the tick's fresh raw into events. "Ingested this tick" =
  // every source polled with status "ok" — INCLUDING 304/no-new-items outcomes,
  // because such a source may still hold pending backlog rows from earlier
  // ingest-only ticks (on prod: the 5406-row month backlog), and its normalizer
  // is a cheap no-op when nothing is pending.
  const ingestOnly = isIngestOnly();
  let materialize: MaterializeResult | null = null;
  if (!ingestOnly) {
    const ingestedKeys = results.filter((r) => r.status === "ok").map((r) => r.source);
    materialize = await materializeTick(ingestedKeys, deadlineMs, deps);
  }

  // T200: an ingest-side cut means the budget ran out BEFORE materialize — report
  // "ingest" as the first stage hit (materialize then defers everything anyway).
  const ingestCut = pool.deferred.length > 0;
  return {
    ok: true,
    total: results.length,
    okCount: results.filter((r) => r.status === "ok").length,
    error: results.filter((r) => r.status === "error").length,
    items: results.reduce((a, r) => a + (r.items || 0), 0),
    results,
    deferred: pool.deferred,
    ingestOnly,
    materialize,
    budget: {
      budgetMs,
      elapsedMs: clock() - startedMs,
      exhausted: ingestCut || (materialize?.budgetExhausted ?? false),
      cutAt: ingestCut ? "ingest" : materialize?.cutAt ?? null,
    },
  };
}

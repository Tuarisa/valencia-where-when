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

// Adaptive ingest dispatcher (sub-area A, research A6). The */15 scheduler tick POSTs
// /api/cron/dispatch → dispatch(), which polls only the sources whose per-source
// cadence says they're DUE, with a bounded concurrency pool, then writes each source's
// cadence state back (next due time, back-off counters, observed change gap).
//
// ingestAll() (force-all, legacy) stays in ingest.ts untouched; dispatch({force:true})
// is the adaptive equivalent that ignores due-times but still updates cadence.

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

export interface DispatchResult {
  ok: boolean;
  total: number;
  okCount: number;
  error: number;
  items: number;
  results: IngestOutcome[];
}

// Bounded pool: process due (or all-enabled when force) sources `concurrency` at a
// time via Promise.allSettled, ingesting then persisting cadence per source. Fail-soft
// — a thrown source never aborts the batch.
export async function dispatch({ concurrency = 5, force = false }: { concurrency?: number; force?: boolean } = {}): Promise<DispatchResult> {
  const now = nowIso();
  const sources = force
    ? ((await sql`SELECT * FROM sources WHERE enabled = 1`) as any[])
    : await selectDueSources(now);

  const results: IngestOutcome[] = [];
  const size = Math.max(1, concurrency);
  for (let i = 0; i < sources.length; i += size) {
    const batch = sources.slice(i, i + size);
    const settled = await Promise.allSettled(
      batch.map(async (source) => {
        // minIntervalHours=0 → bypass the legacy time guard; the cadence due-select
        // already decided this source should run.
        const outcome = await ingestSource(source, 0);
        await applyCadence(source, outcome);
        return outcome;
      }),
    );
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === "fulfilled") {
        results.push(s.value);
      } else {
        results.push({ source: batch[j]?.key ?? "unknown", status: "error", error: String(s.reason) });
      }
    }
  }

  return {
    ok: true,
    total: results.length,
    okCount: results.filter((r) => r.status === "ok").length,
    error: results.filter((r) => r.status === "error").length,
    items: results.reduce((a, r) => a + (r.items || 0), 0),
    results,
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of lib/pipeline/health.ts (T138). Re-implemented here (no TS
// import) — same pattern as tests/cadence.test.mjs / tests/spain-filter.test.mjs. If
// these drift from health.ts the prod health check lies, so keep them lock-step.

const DEFAULT_STALE_GRACE_SEC = 6 * 3600;
const DEFAULT_FAIL_COUNT_LIMIT = 5;
const DEFAULT_PIPELINE_COLD_SEC = 48 * 3600;
const DEFAULT_ENRICH_STALE_SEC = 14 * 24 * 3600;

const isoToMs = (iso) => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

function sourceStale(source, nowIso, opts = {}) {
  const graceSec = opts.graceSec ?? DEFAULT_STALE_GRACE_SEC;
  const failLimit = opts.failCountLimit ?? DEFAULT_FAIL_COUNT_LIMIT;
  const enabled = source.enabled === 1 || source.enabled === true;
  if (!enabled) return { stale: false, reason: null };
  if ((source.last_status || '').toLowerCase() === 'error') {
    return { stale: true, reason: 'last run errored' };
  }
  const failCount = source.fail_count ?? 0;
  if (failCount >= failLimit) {
    return { stale: true, reason: `fail_count ${failCount} ≥ ${failLimit}` };
  }
  const dueMs = isoToMs(source.next_due_at);
  const nowMs = isoToMs(nowIso);
  if (dueMs != null && nowMs != null) {
    const overdueSec = (nowMs - dueMs) / 1000;
    if (overdueSec > graceSec) {
      const overdueH = Math.round((overdueSec / 3600) * 10) / 10;
      return { stale: true, reason: `overdue ${overdueH}h past next_due_at` };
    }
  }
  return { stale: false, reason: null };
}

function pipelineWarnings(input) {
  const coldSec = input.coldSec ?? DEFAULT_PIPELINE_COLD_SEC;
  const out = [];
  const lastMs = isoToMs(input.lastSuccessIso);
  const nowMs = isoToMs(input.nowIso);
  if (lastMs == null) {
    out.push('no pipeline run yet (info)'); // T143: INFO, not a hard fail (seed-only DB)
  } else if (nowMs != null && (nowMs - lastMs) / 1000 > coldSec) {
    const ageH = Math.round(((nowMs - lastMs) / 3600000) * 10) / 10;
    const limitH = Math.round(coldSec / 3600);
    out.push(`no successful pipeline run in ${limitH}h (last ${ageH}h ago)`);
  }
  if (!input.upcomingCount || input.upcomingCount <= 0) {
    out.push('0 upcoming events');
  }
  return out;
}

function enrichStalled(args) {
  if (!args.hasEvents) return false;
  const staleSec = args.staleSec ?? DEFAULT_ENRICH_STALE_SEC;
  const lastMs = isoToMs(args.lastEnrichedIso);
  const nowMs = isoToMs(args.nowIso);
  if (lastMs == null) return true;
  if (nowMs == null) return false;
  return (nowMs - lastMs) / 1000 > staleSec;
}

const NOW = '2026-06-20T12:00:00Z';

// ---- sourceStale ----------------------------------------------------------

test('sourceStale: fresh enabled source (due in the future, no fails, last ok) → not stale', () => {
  const s = { enabled: 1, next_due_at: '2026-06-20T13:00:00Z', fail_count: 0, last_status: 'ok' };
  assert.deepEqual(sourceStale(s, NOW), { stale: false, reason: null });
});

test('sourceStale: just-past next_due_at within grace → still fresh', () => {
  // 1h overdue, grace is 6h → not stale.
  const s = { enabled: 1, next_due_at: '2026-06-20T11:00:00Z', fail_count: 0, last_status: 'ok' };
  assert.equal(sourceStale(s, NOW).stale, false);
});

test('sourceStale: overdue beyond grace → stale with overdue reason', () => {
  // 8h overdue, grace is 6h → stale.
  const s = { enabled: 1, next_due_at: '2026-06-20T04:00:00Z', fail_count: 0, last_status: 'ok' };
  const r = sourceStale(s, NOW);
  assert.equal(r.stale, true);
  assert.match(r.reason, /overdue/);
});

test('sourceStale: errored last run → stale even if due in the future', () => {
  const s = { enabled: 1, next_due_at: '2026-06-21T00:00:00Z', fail_count: 0, last_status: 'error' };
  assert.deepEqual(sourceStale(s, NOW), { stale: true, reason: 'last run errored' });
});

test('sourceStale: fail_count at the limit → stale', () => {
  const s = { enabled: 1, next_due_at: '2026-06-21T00:00:00Z', fail_count: 5, last_status: 'ok' };
  const r = sourceStale(s, NOW);
  assert.equal(r.stale, true);
  assert.match(r.reason, /fail_count/);
});

test('sourceStale: disabled source is NEVER stale (even if overdue + errored)', () => {
  const s = { enabled: 0, next_due_at: '2026-01-01T00:00:00Z', fail_count: 99, last_status: 'error' };
  assert.deepEqual(sourceStale(s, NOW), { stale: false, reason: null });
});

test('sourceStale: never-scheduled enabled source (null next_due_at, ok) → not stale on due alone', () => {
  const s = { enabled: 1, next_due_at: null, fail_count: 0, last_status: null };
  assert.equal(sourceStale(s, NOW).stale, false);
});

test('sourceStale: custom grace tightens the overdue window', () => {
  // 1h overdue; default grace 6h keeps it fresh, but a 30-min grace flips it stale.
  const s = { enabled: 1, next_due_at: '2026-06-20T11:00:00Z', fail_count: 0, last_status: 'ok' };
  assert.equal(sourceStale(s, NOW).stale, false);
  assert.equal(sourceStale(s, NOW, { graceSec: 1800 }).stale, true);
});

// ---- pipelineWarnings -----------------------------------------------------

test('pipelineWarnings: healthy pipeline (recent run + upcoming events) → no warnings', () => {
  const w = pipelineWarnings({ lastSuccessIso: '2026-06-20T06:00:00Z', upcomingCount: 42, nowIso: NOW });
  assert.deepEqual(w, []);
});

test('pipelineWarnings: no successful run in 48h → hard warning', () => {
  // last ok 3 days ago.
  const w = pipelineWarnings({ lastSuccessIso: '2026-06-17T12:00:00Z', upcomingCount: 42, nowIso: NOW });
  assert.equal(w.length, 1);
  assert.match(w[0], /no successful pipeline run in 48h/);
});

test('pipelineWarnings: never ran but healthy data → INFO only, not hard (T143)', () => {
  const w = pipelineWarnings({ lastSuccessIso: null, upcomingCount: 42, nowIso: NOW });
  assert.deepEqual(w, ['no pipeline run yet (info)']);
  // The route treats "(info)"-suffixed warnings as non-hard → ok stays true.
  assert.equal(w.filter((x) => !x.endsWith('(info)')).length, 0);
});

test('pipelineWarnings: never ran AND empty DB → 0-upcoming is still a HARD fail (T143)', () => {
  const w = pipelineWarnings({ lastSuccessIso: null, upcomingCount: 0, nowIso: NOW });
  assert.deepEqual(w, ['no pipeline run yet (info)', '0 upcoming events']);
  // A truly-empty fresh deploy is still caught: one hard warning remains.
  assert.equal(w.filter((x) => !x.endsWith('(info)')).length, 1);
});

test('pipelineWarnings: zero upcoming events → warning', () => {
  const w = pipelineWarnings({ lastSuccessIso: '2026-06-20T06:00:00Z', upcomingCount: 0, nowIso: NOW });
  assert.deepEqual(w, ['0 upcoming events']);
});

test('pipelineWarnings: both cold and empty → two warnings', () => {
  const w = pipelineWarnings({ lastSuccessIso: '2026-06-01T00:00:00Z', upcomingCount: 0, nowIso: NOW });
  assert.equal(w.length, 2);
});

test('pipelineWarnings: run just inside 48h (e.g. 47h ago) → no warning', () => {
  // 47h before NOW = 2026-06-18T13:00:00Z.
  const w = pipelineWarnings({ lastSuccessIso: '2026-06-18T13:00:00Z', upcomingCount: 10, nowIso: NOW });
  assert.deepEqual(w, []);
});

// ---- enrichStalled (INFO only) --------------------------------------------

test('enrichStalled: no events → never stalled', () => {
  assert.equal(enrichStalled({ lastEnrichedIso: null, hasEvents: false, nowIso: NOW }), false);
});

test('enrichStalled: events but never enriched → stalled (info)', () => {
  assert.equal(enrichStalled({ lastEnrichedIso: null, hasEvents: true, nowIso: NOW }), true);
});

test('enrichStalled: enriched recently → not stalled', () => {
  assert.equal(enrichStalled({ lastEnrichedIso: '2026-06-19T12:00:00Z', hasEvents: true, nowIso: NOW }), false);
});

test('enrichStalled: enriched long ago (> 14d) → stalled (info)', () => {
  assert.equal(enrichStalled({ lastEnrichedIso: '2026-05-01T12:00:00Z', hasEvents: true, nowIso: NOW }), true);
});

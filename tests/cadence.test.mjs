import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of lib/pipeline/cadence.ts (T012/T015). Re-implemented here (no TS
// import) — same pattern as tests/spain-filter.test.mjs. If these drift from cadence.ts
// the dispatcher's throttling is wrong, so keep them lock-step.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function computePollInterval({ observedGapSec, minIntervalSec, maxIntervalSec }) {
  if (!observedGapSec) return minIntervalSec;
  return clamp(Math.round(observedGapSec * 0.33), minIntervalSec, maxIntervalSec);
}

const backoffUnchanged = (baseSec, n, maxSec) =>
  clamp(Math.round(baseSec * Math.pow(1.5, n)), baseSec, maxSec);

const backoffError = (baseSec, failCount, maxSec) =>
  clamp(Math.round(baseSec * Math.pow(2, failCount)), baseSec, maxSec);

const isDue = (s, nowIso) => !s.next_due_at || s.next_due_at <= nowIso;

function selectDue(sources, nowIso) {
  return sources
    .filter((s) => s.enabled === 1 && isDue(s, nowIso))
    .sort((a, b) => {
      if (!a.next_due_at && !b.next_due_at) return 0;
      if (!a.next_due_at) return -1;
      if (!b.next_due_at) return 1;
      return a.next_due_at < b.next_due_at ? -1 : a.next_due_at > b.next_due_at ? 1 : 0;
    });
}

test('clamp bounds below/within/above', () => {
  assert.equal(clamp(5, 10, 100), 10);
  assert.equal(clamp(50, 10, 100), 50);
  assert.equal(clamp(500, 10, 100), 100);
});

test('computePollInterval: gap × 0.33 clamped to [min,max]', () => {
  // 30000 × 0.33 = 9900, within window → returned as-is.
  assert.equal(computePollInterval({ observedGapSec: 30000, minIntervalSec: 3600, maxIntervalSec: 86400 }), 9900);
  // gap × 0.33 below min → clamped up to min.
  assert.equal(computePollInterval({ observedGapSec: 3000, minIntervalSec: 3600, maxIntervalSec: 86400 }), 3600);
  // gap × 0.33 above max → clamped down to max.
  assert.equal(computePollInterval({ observedGapSec: 1_000_000, minIntervalSec: 3600, maxIntervalSec: 86400 }), 86400);
});

test('computePollInterval: null/0 gap → min (never-changed source)', () => {
  assert.equal(computePollInterval({ observedGapSec: null, minIntervalSec: 600, maxIntervalSec: 10800 }), 600);
  assert.equal(computePollInterval({ observedGapSec: 0, minIntervalSec: 600, maxIntervalSec: 10800 }), 600);
});

test('backoffUnchanged: ×1.5 geometric growth, capped at max', () => {
  const base = 600;
  const max = 10800;
  assert.equal(backoffUnchanged(base, 0, max), 600);    // ×1
  assert.equal(backoffUnchanged(base, 1, max), 900);    // ×1.5
  assert.equal(backoffUnchanged(base, 2, max), 1350);   // ×2.25
  assert.equal(backoffUnchanged(base, 3, max), 2025);   // ×3.375
  // grows monotonically and is capped at max for large n.
  assert.equal(backoffUnchanged(base, 50, max), max);
  assert.ok(backoffUnchanged(base, 4, max) > backoffUnchanged(base, 3, max));
});

test('backoffError: ×2 exponential growth, capped at max', () => {
  const base = 600;
  const max = 86400;
  assert.equal(backoffError(base, 0, max), 600);    // ×1
  assert.equal(backoffError(base, 1, max), 1200);   // ×2
  assert.equal(backoffError(base, 2, max), 2400);   // ×4
  assert.equal(backoffError(base, 3, max), 4800);   // ×8
  // error back-off outruns unchanged back-off at the same step.
  assert.ok(backoffError(base, 3, max) > backoffUnchanged(base, 3, max));
  // capped at max.
  assert.equal(backoffError(base, 40, max), max);
});

test('selectDue: nulls first, then ascending next_due_at; drops disabled & not-due', () => {
  const now = '2026-06-20T12:00:00Z';
  const sources = [
    { key: 'b', enabled: 1, next_due_at: '2026-06-20T11:00:00Z' }, // overdue
    { key: 'a', enabled: 1, next_due_at: null },                   // never polled
    { key: 'future', enabled: 1, next_due_at: '2026-06-20T13:00:00Z' }, // not due yet
    { key: 'disabled', enabled: 0, next_due_at: null },            // disabled
    { key: 'c', enabled: 1, next_due_at: '2026-06-20T11:30:00Z' }, // overdue, later than b
    { key: 'edge', enabled: 1, next_due_at: '2026-06-20T12:00:00Z' }, // due exactly now
  ];
  const due = selectDue(sources, now).map((s) => s.key);
  assert.deepEqual(due, ['a', 'b', 'c', 'edge']);
  assert.ok(!due.includes('future'), 'not-yet-due dropped');
  assert.ok(!due.includes('disabled'), 'disabled dropped');
});

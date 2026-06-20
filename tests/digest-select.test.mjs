import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of lib/pipeline/notify.ts digest + series selectors (T073/T074).
// No TS import (matches tests/spain-filter.test.mjs / tests/notify.test.mjs).
const CONFIDENCE_HOLD = 0.6;
const DIGEST_HORIZON_DAYS = 21;
const DIGEST_SCORE_THRESHOLD = 55;
const EXCLUDE = ['news', 'politics', 'politica', 'política', 'noticias', 'spainnews'];

function parseTags(c) {
  try { const a = JSON.parse(c.tags_json || '[]'); return Array.isArray(a) ? a.map((t) => String(t).toLowerCase()) : []; }
  catch { return []; }
}
function isFamilyFit(c) {
  const cat = (c.category || '').toLowerCase();
  const tags = parseTags(c);
  return !EXCLUDE.some((x) => cat.includes(x) || tags.some((t) => t.includes(x)));
}
function cardConfidence(c) {
  if (!c.enriched_at) return null;
  try { const e = JSON.parse(c.enrichment_json || '{}'); return typeof e?.confidence === 'number' ? e.confidence : null; }
  catch { return null; }
}
function addDays(date, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
function withinHorizon(date, today, horizonDays) {
  if (!date) return false;
  const d = date.slice(0, 10);
  return d >= today && d <= addDays(today, horizonDays);
}
function selectDigest(cands, { today, horizonDays = DIGEST_HORIZON_DAYS, threshold = DIGEST_SCORE_THRESHOLD, holdThreshold = CONFIDENCE_HOLD }) {
  return cands.filter((c) => {
    if (c.notified) return false;
    if ((c.score ?? 0) < threshold) return false;
    if (!isFamilyFit(c)) return false;
    if (!withinHorizon(c.start_date, today, horizonDays)) return false;
    const conf = cardConfidence(c);
    if (conf != null && conf < holdThreshold) return false;
    return true;
  });
}

// --- series helpers (T073) -------------------------------------------------
function nextOccurrence(occurrences, today) {
  if (!Array.isArray(occurrences)) return null;
  let best = null;
  for (const o of occurrences) {
    const d = (o?.occurrence_date || '').slice(0, 10);
    if (!d || d < today) continue;
    if ((o?.status || 'upcoming') === 'cancelled') continue;
    if (best == null || d < best) best = d;
  }
  return best;
}
function selectSeriesDigest(series, { today, horizonDays = DIGEST_HORIZON_DAYS, threshold = DIGEST_SCORE_THRESHOLD, holdThreshold = CONFIDENCE_HOLD }) {
  const out = [];
  for (const s of series) {
    if (s.notified) continue;
    if ((s.score ?? 0) < threshold) continue;
    if (!isFamilyFit(s)) continue;
    const next = s.next_occurrence ?? nextOccurrence(s.occurrences, today) ?? s.start_date ?? null;
    if (!withinHorizon(next, today, horizonDays)) continue;
    const conf = cardConfidence(s);
    if (conf != null && conf < holdThreshold) continue;
    out.push({ ...s, next_occurrence: next, start_date: next });
  }
  return out;
}

const TODAY = '2026-06-20';

test('selectDigest: within-horizon gate (today/end inclusive, before/after out)', () => {
  const cands = [
    { id: 1, start_date: TODAY, score: 70, notified: 0, category: 'concert' },         // today ✓
    { id: 2, start_date: '2026-07-11', score: 70, notified: 0, category: 'concert' },   // end inclusive ✓
    { id: 3, start_date: '2026-07-12', score: 70, notified: 0, category: 'concert' },   // 1 day past horizon ✗
    { id: 4, start_date: '2026-06-19', score: 70, notified: 0, category: 'concert' },   // before today ✗
    { id: 5, start_date: null, score: 70, notified: 0, category: 'concert' },           // no date ✗
  ];
  assert.deepEqual(selectDigest(cands, { today: TODAY }).map((c) => c.id), [1, 2]);
});

test('selectDigest: family-fit filter drops political news (cat + tag)', () => {
  const cands = [
    { id: 1, start_date: '2026-06-25', score: 70, notified: 0, category: 'concert' },                  // ✓
    { id: 2, start_date: '2026-06-25', score: 70, notified: 0, category: 'news' },                     // cat ✗
    { id: 3, start_date: '2026-06-25', score: 70, notified: 0, category: 'misc', tags_json: '["politics"]' }, // tag ✗
  ];
  assert.deepEqual(selectDigest(cands, { today: TODAY }).map((c) => c.id), [1]);
});

test('selectDigest: confidence-hold gate (enriched & conf < hold withheld, un-enriched shown)', () => {
  const cands = [
    { id: 1, start_date: '2026-06-25', score: 70, notified: 0 },                                                   // un-enriched ✓
    { id: 2, start_date: '2026-06-25', score: 70, notified: 0, enriched_at: 'x', enrichment_json: '{"confidence":0.4}' }, // held ✗
    { id: 3, start_date: '2026-06-25', score: 70, notified: 0, enriched_at: 'x', enrichment_json: '{"confidence":0.6}' }, // at floor ✓
    { id: 4, start_date: '2026-06-25', score: 70, notified: 0, enriched_at: 'x', enrichment_json: '{"confidence":0.9}' }, // ✓
  ];
  assert.deepEqual(selectDigest(cands, { today: TODAY }).map((c) => c.id), [1, 3, 4]);
});

test('selectDigest: threshold floor and no-repeat (already-notified excluded)', () => {
  const cands = [
    { id: 1, start_date: '2026-06-25', score: 54, notified: 0, category: 'concert' },  // below floor ✗
    { id: 2, start_date: '2026-06-25', score: 55, notified: 0, category: 'concert' },  // at floor ✓
    { id: 3, start_date: '2026-06-25', score: 90, notified: 1, category: 'concert' },  // already notified ✗
  ];
  assert.deepEqual(selectDigest(cands, { today: TODAY }).map((c) => c.id), [2]);
});

test('selectDigest is idempotent: re-run after notifying yields 0 repeats (SC-002)', () => {
  const cands = [{ id: 1, start_date: '2026-06-25', score: 70, notified: 0, category: 'concert' }];
  const first = selectDigest(cands, { today: TODAY }).map((c) => c.id);
  assert.deepEqual(first, [1]);
  // simulate markNotified
  for (const c of cands) if (first.includes(c.id)) c.notified = 1;
  assert.deepEqual(selectDigest(cands, { today: TODAY }).map((c) => c.id), [], 'second run = no repeats');
});

test('nextOccurrence: earliest non-cancelled date >= today; null when all past/cancelled', () => {
  const occ = [
    { occurrence_date: '2026-06-10' },                       // past
    { occurrence_date: '2026-07-05' },                       // future
    { occurrence_date: '2026-06-28', status: 'cancelled' },  // cancelled
    { occurrence_date: '2026-06-25' },                       // earliest upcoming
  ];
  assert.equal(nextOccurrence(occ, TODAY), '2026-06-25');
  assert.equal(nextOccurrence([{ occurrence_date: '2026-06-01' }], TODAY), null, 'all past → null');
  assert.equal(nextOccurrence([{ occurrence_date: '2026-06-25', status: 'cancelled' }], TODAY), null, 'all cancelled → null');
  assert.equal(nextOccurrence(null, TODAY), null);
});

test('selectSeriesDigest: ONE card per series, next occurrence picked + within horizon', () => {
  const series = [
    // next upcoming = 2026-06-25 (in horizon) ✓
    { id: 1, title: 'Planetario', score: 80, notified: 0, occurrences: [
      { occurrence_date: '2026-06-10' }, { occurrence_date: '2026-06-25' }, { occurrence_date: '2026-08-01' },
    ] },
    // pre-computed next_occurrence past horizon ✗
    { id: 2, title: 'Lejos', score: 80, notified: 0, next_occurrence: '2026-09-01' },
    // every occurrence in the past → no next → ✗
    { id: 3, title: 'Pasado', score: 80, notified: 0, occurrences: [{ occurrence_date: '2026-05-01' }] },
  ];
  const sel = selectSeriesDigest(series, { today: TODAY });
  assert.deepEqual(sel.map((s) => s.id), [1]);
  assert.equal(sel[0].next_occurrence, '2026-06-25', 'series collapses to its NEXT date');
  assert.equal(sel[0].start_date, '2026-06-25', 'next date promoted to start_date for rendering');
});

test('selectSeriesDigest: same gates as events (threshold, family-fit, confidence, no-repeat)', () => {
  const series = [
    { id: 1, title: 'Low', score: 40, notified: 0, next_occurrence: '2026-06-25' },                                  // below floor ✗
    { id: 2, title: 'News', score: 80, notified: 0, category: 'news', next_occurrence: '2026-06-25' },               // family-fit ✗
    { id: 3, title: 'Held', score: 80, notified: 0, enriched_at: 'x', enrichment_json: '{"confidence":0.3}', next_occurrence: '2026-06-25' }, // held ✗
    { id: 4, title: 'Done', score: 80, notified: 1, next_occurrence: '2026-06-25' },                                 // already notified ✗
    { id: 5, title: 'Good', score: 80, notified: 0, next_occurrence: '2026-06-25' },                                 // ✓
  ];
  assert.deepEqual(selectSeriesDigest(series, { today: TODAY }).map((s) => s.id), [5]);
});

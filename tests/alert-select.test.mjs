import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of lib/pipeline/notify.ts selectAlerts (rare/high-signal, T074).
// No TS import (matches tests/spain-filter.test.mjs / tests/notify.test.mjs).
const CONFIDENCE_HOLD = 0.6;
const ALERT_SCORE_THRESHOLD = 85;
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
function selectAlerts(cands, { alertThreshold = ALERT_SCORE_THRESHOLD, holdThreshold = CONFIDENCE_HOLD } = {}) {
  return cands.filter((c) => {
    if (c.notified) return false;
    if ((c.score ?? 0) < alertThreshold) return false;
    if (!isFamilyFit(c)) return false;
    const conf = cardConfidence(c);
    if (conf != null && conf < holdThreshold) return false;
    return true;
  });
}

test('selectAlerts: high score bar (>= 85), below-bar dropped', () => {
  const cands = [
    { id: 1, score: 84, notified: 0 },  // below bar ✗
    { id: 2, score: 85, notified: 0 },  // at bar ✓
    { id: 3, score: 99, notified: 0 },  // ✓
  ];
  assert.deepEqual(selectAlerts(cands).map((c) => c.id), [2, 3]);
});

test('selectAlerts: ignores horizon — a far-future high-signal item still fires', () => {
  const cands = [
    { id: 1, score: 90, notified: 0, start_date: '2027-01-01' }, // far future, still ✓
    { id: 2, score: 90, notified: 0, start_date: null },         // dateless, still ✓
  ];
  assert.deepEqual(selectAlerts(cands).map((c) => c.id), [1, 2]);
});

test('selectAlerts: family-fit + confidence-hold gates still apply', () => {
  const cands = [
    { id: 1, score: 95, notified: 0, category: 'news' },                                                  // family-fit ✗
    { id: 2, score: 95, notified: 0, tags_json: '["politics"]' },                                         // family-fit ✗
    { id: 3, score: 95, notified: 0, enriched_at: 'x', enrichment_json: '{"confidence":0.3}' },           // held ✗
    { id: 4, score: 95, notified: 0, enriched_at: 'x', enrichment_json: '{"confidence":0.9}' },           // ✓
    { id: 5, score: 95, notified: 0 },                                                                    // un-enriched ✓
  ];
  assert.deepEqual(selectAlerts(cands).map((c) => c.id), [4, 5]);
});

test('selectAlerts: no-repeat — already-notified excluded', () => {
  const cands = [
    { id: 1, score: 95, notified: 1 },  // already notified ✗
    { id: 2, score: 95, notified: 0 },  // ✓
  ];
  assert.deepEqual(selectAlerts(cands).map((c) => c.id), [2]);
});

test('selectAlerts is idempotent: re-run after notifying yields 0 repeats (SC-002)', () => {
  const cands = [{ id: 1, score: 95, notified: 0 }];
  const first = selectAlerts(cands).map((c) => c.id);
  assert.deepEqual(first, [1]);
  for (const c of cands) if (first.includes(c.id)) c.notified = 1;
  assert.deepEqual(selectAlerts(cands).map((c) => c.id), [], 'second run = no repeats');
});

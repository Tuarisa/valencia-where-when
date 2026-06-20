import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of the digest/alert selectors (lib/pipeline/notify.ts, sub-area G).
const CONFIDENCE_HOLD = 0.6;
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
function selectDigest(cands, { today, horizonDays = 21, threshold = 55, holdThreshold = CONFIDENCE_HOLD }) {
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
function selectAlerts(cands, { alertThreshold = 85, holdThreshold = CONFIDENCE_HOLD } = {}) {
  return cands.filter((c) => {
    if (c.notified) return false;
    if ((c.score ?? 0) < alertThreshold) return false;
    if (!isFamilyFit(c)) return false;
    const conf = cardConfidence(c);
    if (conf != null && conf < holdThreshold) return false;
    return true;
  });
}

const TODAY = '2026-06-20';

test('addDays / withinHorizon boundaries', () => {
  assert.equal(addDays('2026-06-20', 21), '2026-07-11');
  assert.equal(withinHorizon('2026-06-20', TODAY, 21), true, 'today is in horizon');
  assert.equal(withinHorizon('2026-07-11', TODAY, 21), true, 'horizon end inclusive');
  assert.equal(withinHorizon('2026-07-12', TODAY, 21), false, 'past horizon');
  assert.equal(withinHorizon('2026-06-19', TODAY, 21), false, 'before today');
  assert.equal(withinHorizon(null, TODAY, 21), false);
});

test('isFamilyFit excludes political news', () => {
  assert.equal(isFamilyFit({ category: 'concert' }), true);
  assert.equal(isFamilyFit({ category: 'news' }), false);
  assert.equal(isFamilyFit({ tags_json: '["politics","es"]' }), false);
});

test('cardConfidence: null when un-enriched, value when enriched', () => {
  assert.equal(cardConfidence({ enriched_at: null }), null);
  assert.equal(cardConfidence({ enriched_at: 'x', enrichment_json: '{"confidence":0.8}' }), 0.8);
  assert.equal(cardConfidence({ enriched_at: 'x', enrichment_json: 'bad' }), null);
});

test('selectDigest applies all gates', () => {
  const cands = [
    { id: 1, start_date: '2026-06-25', score: 70, notified: 0, category: 'concert' }, // ✓
    { id: 2, start_date: '2026-06-25', score: 70, notified: 1, category: 'concert' }, // notified
    { id: 3, start_date: '2026-06-25', score: 30, notified: 0, category: 'concert' }, // low score
    { id: 4, start_date: '2026-09-01', score: 90, notified: 0, category: 'concert' }, // out of horizon
    { id: 5, start_date: '2026-06-25', score: 70, notified: 0, category: 'news' },    // excluded
    { id: 6, start_date: '2026-06-25', score: 70, notified: 0, enriched_at: 'x', enrichment_json: '{"confidence":0.4}' }, // held
    { id: 7, start_date: '2026-06-25', score: 70, notified: 0, enriched_at: 'x', enrichment_json: '{"confidence":0.9}' }, // ✓
  ];
  const sel = selectDigest(cands, { today: TODAY }).map((c) => c.id);
  assert.deepEqual(sel, [1, 7]);
});

test('selectAlerts uses a higher bar and ignores horizon', () => {
  const cands = [
    { id: 1, score: 90, notified: 0, start_date: '2026-09-01' }, // ✓ (high score, far date ok)
    { id: 2, score: 70, notified: 0, start_date: '2026-06-25' }, // below alert bar
    { id: 3, score: 95, notified: 1, start_date: '2026-06-25' }, // notified
  ];
  assert.deepEqual(selectAlerts(cands).map((c) => c.id), [1]);
});

// mirror of renderDigestText
function renderDigestText(events, places, mode = 'weekly') {
  const lines = [];
  lines.push(mode === 'alert' ? '🔔 Valencia Radar — срочно' : '📅 Valencia Radar — афиша на 2–3 недели');
  lines.push('');
  if (events.length === 0) lines.push('Ничего нового, подходящего семье, не найдено.');
  else for (const e of events) {
    const date = (e.start_date || '').slice(0, 10) || 'дата уточняется';
    lines.push(`• ${date} — ${e.title ?? '(без названия)'}${e.score != null ? ` (score ${e.score})` : ''}`);
  }
  if (mode === 'weekly' && places.length) {
    lines.push('');
    lines.push('📍 Новые места на радаре:');
    for (const p of places) lines.push(`• ${p.name ?? '(место)'}${p.category ? ` — ${p.category}` : ''}`);
  }
  return lines.join('\n');
}

test('renderDigestText: events + new-places block, and empty case', () => {
  const txt = renderDigestText([{ start_date: '2026-06-25', title: 'Концерт', score: 80 }], [{ name: 'Bar Pepe', category: 'bar' }], 'weekly');
  assert.ok(txt.includes('Концерт') && txt.includes('2026-06-25'));
  assert.ok(txt.includes('Новые места') && txt.includes('Bar Pepe'));
  assert.ok(renderDigestText([], [], 'weekly').includes('Ничего нового'));
});

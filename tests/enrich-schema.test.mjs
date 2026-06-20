import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of the enrichment schema gate (lib/pipeline/enrich.ts, sub-area E,
// T051/T052/T054). These re-implement normalizeEnrichment / clampConfidence /
// groundReport / applyGroundOrFlag / needsEnrich + the COALESCE merge rule so the
// contract is pinned with NO key/network/DB (constitution IV: mockable + offline).

const CONFIDENCE_HOLD = 0.6;

const NULLABLE_STRING_FIELDS = [
  'category', 'start_date', 'end_date', 'start_time', 'end_time',
  'venue_name', 'address', 'district', 'price', 'maps_url', 'image_url',
  'ocr_text', 'notes', 'model',
];
const GROUNDABLE_FACTS = [
  'start_date', 'end_date', 'start_time', 'end_time', 'venue_name', 'address', 'price',
];

function toNullableString(v) {
  if (v == null) return null;
  if (typeof v === 'string') { const t = v.trim(); return t === '' ? null : t; }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}
function toNullableBool(v) {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (['true', 'yes', '1', 'free', 'gratis', 'бесплатно'].includes(t)) return true;
    if (['false', 'no', '0', 'paid'].includes(t)) return false;
  }
  if (typeof v === 'number') return v !== 0;
  return null;
}
function clampConfidence(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
function normalizeLinks(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const url = toNullableString(item.url);
    if (!url) continue;
    out.push({ label: toNullableString(item.label) ?? url, url });
  }
  return out;
}
function normalizeCitations(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const url = toNullableString(item.url);
    if (!url) continue;
    out.push({ url, supports: toNullableString(item.supports) ?? '' });
  }
  return out;
}
function normalizeEnrichment(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const out = {
    title_ru: toNullableString(r.title_ru) ?? '',
    description_ru: toNullableString(r.description_ru) ?? '',
    confidence: clampConfidence(r.confidence),
  };
  for (const k of NULLABLE_STRING_FIELDS) out[k] = toNullableString(r[k]);
  out.is_free = toNullableBool(r.is_free);
  out.links = normalizeLinks(r.links);
  out.citations = normalizeCitations(r.citations);
  return out;
}
function groundReport(r) {
  const flags = [];
  const hasCitations = (r.citations?.length ?? 0) > 0;
  const ungroundedFacts = [];
  if (!hasCitations) for (const f of GROUNDABLE_FACTS) if (r[f] != null) ungroundedFacts.push(f);
  if (ungroundedFacts.length) flags.push(`ungrounded facts (no citation): ${ungroundedFacts.join(', ')}`);
  const held = r.confidence < CONFIDENCE_HOLD;
  if (held) flags.push(`confidence ${r.confidence.toFixed(2)} < hold ${CONFIDENCE_HOLD}`);
  return { held, flags, ungroundedFacts };
}
function applyGroundOrFlag(r) {
  const report = groundReport(r);
  if (!report.flags.length) return r;
  const prior = r.notes ? `${r.notes} ` : '';
  return { ...r, notes: `${prior}[${report.flags.join('; ')}]` };
}
function needsEnrich(row, force = false) {
  if (force) return true;
  if (!row.enriched_at) return true;
  if (row.last_seen && row.last_seen > row.enriched_at) return true;
  return false;
}

// ── T051: normalize / validate ──────────────────────────────────────────────

test('normalizeEnrichment drops unknown keys', () => {
  const r = normalizeEnrichment({
    title_ru: 'Заголовок', description_ru: 'Текст', confidence: 0.9,
    evil: 'DROP TABLE events', __proto__hack: 1, extra_column: 'x',
  });
  assert.equal(r.title_ru, 'Заголовок');
  assert.ok(!('evil' in r), 'unknown key dropped');
  assert.ok(!('extra_column' in r), 'unknown key dropped');
  // only canonical keys remain
  const allowed = new Set([...NULLABLE_STRING_FIELDS, 'title_ru', 'description_ru', 'confidence', 'is_free', 'links', 'citations']);
  for (const k of Object.keys(r)) assert.ok(allowed.has(k), `unexpected key ${k}`);
});

test('clampConfidence clamps to [0,1]; junk → 0', () => {
  assert.equal(clampConfidence(1.7), 1);
  assert.equal(clampConfidence(-0.2), 0);
  assert.equal(clampConfidence(0.42), 0.42);
  assert.equal(clampConfidence('0.8'), 0.8);
  assert.equal(clampConfidence('nonsense'), 0);
  assert.equal(clampConfidence(undefined), 0);
  assert.equal(clampConfidence(NaN), 0);
});

test('normalizeEnrichment: confidence clamped in the full object', () => {
  assert.equal(normalizeEnrichment({ confidence: 5 }).confidence, 1);
  assert.equal(normalizeEnrichment({ confidence: -3 }).confidence, 0);
  assert.equal(normalizeEnrichment({}).confidence, 0, 'missing confidence → 0');
});

test('normalizeEnrichment: blank strings → null; required fields default to ""', () => {
  const r = normalizeEnrichment({ title_ru: '  ', venue_name: '', address: '   ', price: '40 €' });
  assert.equal(r.title_ru, '', 'blank required → empty string');
  assert.equal(r.venue_name, null, 'blank optional → null');
  assert.equal(r.address, null);
  assert.equal(r.price, '40 €');
});

test('normalizeEnrichment: is_free coercion + links/citations shaping', () => {
  const r = normalizeEnrichment({
    is_free: 'yes',
    links: [{ label: 'Site', url: 'https://x' }, { label: 'no-url' }, 'junk'],
    citations: [{ url: 'https://src', supports: 'price' }, { supports: 'no-url' }],
  });
  assert.equal(r.is_free, true);
  assert.deepEqual(r.links, [{ label: 'Site', url: 'https://x' }], 'link without url dropped');
  assert.deepEqual(r.citations, [{ url: 'https://src', supports: 'price' }], 'citation without url dropped');
});

test('normalizeEnrichment is total: junk input → minimal valid card', () => {
  for (const junk of [null, undefined, 42, 'string', []]) {
    const r = normalizeEnrichment(junk);
    assert.equal(r.title_ru, '');
    assert.equal(r.confidence, 0);
    assert.deepEqual(r.links, []);
  }
});

// ── T052: ground-or-flag ────────────────────────────────────────────────────

test('groundReport: below-hold confidence is flagged (held), not published', () => {
  assert.equal(groundReport(normalizeEnrichment({ confidence: 0.5 })).held, true);
  assert.equal(groundReport(normalizeEnrichment({ confidence: 0.6 })).held, false, 'hold is inclusive');
  assert.equal(groundReport(normalizeEnrichment({ confidence: 0.9 })).held, false);
});

test('groundReport: facts asserted without a citation are flagged', () => {
  const ungrounded = normalizeEnrichment({ confidence: 0.9, start_date: '2026-07-01', price: '10 €' });
  const rep = groundReport(ungrounded);
  assert.deepEqual(rep.ungroundedFacts.sort(), ['price', 'start_date']);
  assert.ok(rep.flags.some((f) => f.includes('ungrounded')));

  const grounded = normalizeEnrichment({
    confidence: 0.9, start_date: '2026-07-01',
    citations: [{ url: 'https://src', supports: 'date' }],
  });
  assert.deepEqual(groundReport(grounded).ungroundedFacts, [], 'citation present → grounded');
});

test('applyGroundOrFlag: folds flags into notes, preserving prior note', () => {
  const r = normalizeEnrichment({ confidence: 0.4, notes: 'poster only', start_date: '2026-07-01' });
  const flagged = applyGroundOrFlag(r);
  assert.ok(flagged.notes.startsWith('poster only'));
  assert.ok(flagged.notes.includes('confidence 0.40 < hold 0.6'));
  assert.ok(flagged.notes.includes('ungrounded'));
});

test('applyGroundOrFlag: clean high-confidence grounded card is untouched', () => {
  const r = normalizeEnrichment({
    title_ru: 'X', description_ru: 'Y', confidence: 0.95,
    start_date: '2026-07-01', citations: [{ url: 'https://src', supports: 'date' }],
  });
  assert.equal(applyGroundOrFlag(r), r, 'no flags → same object reference');
});

// ── T054: series-aware re-enrich trigger ─────────────────────────────────────

test('needsEnrich: never enriched → true', () => {
  assert.equal(needsEnrich({ enriched_at: null, last_seen: '2026-06-20T00:00:00Z' }), true);
  assert.equal(needsEnrich({ last_seen: '2026-06-20T00:00:00Z' }), true);
});

test('needsEnrich: source changed since enrichment (last_seen > enriched_at) → true', () => {
  assert.equal(needsEnrich({ enriched_at: '2026-06-19T00:00:00Z', last_seen: '2026-06-20T00:00:00Z' }), true);
});

test('needsEnrich: enriched and unchanged → false (idempotent re-run)', () => {
  assert.equal(needsEnrich({ enriched_at: '2026-06-20T00:00:00Z', last_seen: '2026-06-20T00:00:00Z' }), false);
  assert.equal(needsEnrich({ enriched_at: '2026-06-21T00:00:00Z', last_seen: '2026-06-20T00:00:00Z' }), false);
});

test('needsEnrich: force overrides everything', () => {
  assert.equal(needsEnrich({ enriched_at: '2026-06-21T00:00:00Z', last_seen: '2026-06-20T00:00:00Z' }, true), true);
});

// ── COALESCE merge rule mirror (model null never clobbers a good column) ──────

function coalesce(modelValue, existing) {
  return modelValue == null ? existing : modelValue;
}
const intBool = (v) => (v == null ? null : v ? 1 : 0);

test('COALESCE preserve: model null keeps existing column; non-null promotes', () => {
  // promote good model value
  assert.equal(coalesce('Театр', null), 'Театр');
  // model null → keep existing enriched value (idempotent re-run preserves it)
  assert.equal(coalesce(null, 'Театр'), 'Театр');
  // is_free: false → 0 (promotes), null → preserve existing
  assert.equal(coalesce(intBool(false), 1), 0);
  assert.equal(coalesce(intBool(null), 1), 1, 'unknown is_free preserves prior');
});

test('COALESCE preserve: a normalized blank string becomes null and preserves prior', () => {
  // model returned "" → normalized to null → must NOT clobber the existing venue
  const r = normalizeEnrichment({ venue_name: '' });
  assert.equal(coalesce(r.venue_name, 'Palau de la Música'), 'Palau de la Música');
});

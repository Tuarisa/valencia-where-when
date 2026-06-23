import test from 'node:test';
import assert from 'node:assert/strict';

// Tests for lib/categories.ts (T178). Imports the REAL pure helpers from the TS module
// (run via `node --import tsx --test`) so assertions exercise the shipped logic. The
// module is DB-free + pure (no network, no lib/db) — it's imported by a CLIENT component
// (app/Home.tsx). These tests prove canonicalCategory collapses the EN/RU + singular/
// plural + casing variants that produced ~41 near-duplicate filter chips down to one
// canonical RU key per real category.
import { canonicalCategory, categoryLabelRu } from '../lib/categories.ts';

test('concert / Concert / concerts / Концерт / концерты all collapse to концерт', () => {
  for (const raw of ['concert', 'Concert', 'concerts', 'CONCERTS', 'Концерт', 'концерт', 'Концерты', '  Concert  ']) {
    assert.equal(canonicalCategory(raw), 'концерт', `${raw} → концерт`);
  }
});

test('music / Music / музыка / Музыка fold into the концерт bucket', () => {
  for (const raw of ['music', 'Music', 'музыка', 'Музыка', 'jazz', 'Джаз', 'Концерты и музыка', 'Музыка и театр']) {
    assert.equal(canonicalCategory(raw), 'концерт', `${raw} → концерт`);
  }
});

test('exhibition / выставка / Выставка collapse to выставка', () => {
  for (const raw of ['exhibition', 'выставка', 'Выставка', 'EXHIBITION', 'выставка / корабль-музей']) {
    assert.equal(canonicalCategory(raw), 'выставка', `${raw} → выставка`);
  }
});

test('theatre / театр + Балет collapse to театр', () => {
  for (const raw of ['theatre', 'theater', 'театр', 'Театр', 'Балет', 'ballet']) {
    assert.equal(canonicalCategory(raw), 'театр', `${raw} → театр`);
  }
});

test('cinema / film / кино / Кино collapse to кино', () => {
  for (const raw of ['cinema', 'film', 'кино', 'Кино']) {
    assert.equal(canonicalCategory(raw), 'кино', `${raw} → кино`);
  }
});

test('festival / праздник / gastronomy / fireworks fold into фестиваль', () => {
  for (const raw of ['festival', 'Festival', 'фестиваль', 'Праздник', 'праздник', 'Праздники', 'gastronomy', 'Гастрономический фестиваль', 'fireworks', 'фейерверк']) {
    assert.equal(canonicalCategory(raw), 'фестиваль', `${raw} → фестиваль`);
  }
});

test('entertainment / show / развлечения collapse to развлечения', () => {
  for (const raw of ['entertainment', 'Entertainment', 'show', 'развлечения', 'Развлечения']) {
    assert.equal(canonicalCategory(raw), 'развлечения', `${raw} → развлечения`);
  }
});

test('culture / культура stay as their own bucket культура', () => {
  for (const raw of ['culture', 'culture', 'культура', 'Культура']) {
    assert.equal(canonicalCategory(raw), 'культура', `${raw} → культура`);
  }
});

test('lecture / лекция and stand-up / стендап collapse', () => {
  assert.equal(canonicalCategory('Лекция'), 'лекция');
  assert.equal(canonicalCategory('lecture'), 'лекция');
  assert.equal(canonicalCategory('Stand-up'), 'стендап');
  assert.equal(canonicalCategory('standup'), 'стендап');
});

test('plural folds to singular for unmapped RU plurals', () => {
  // лекции / экскурсии are mapped; the generic ы/и fold covers stray unmapped plurals.
  assert.equal(canonicalCategory('экскурсии'), 'экскурсия');
  assert.equal(canonicalCategory('лекции'), 'лекция');
});

test('unknown values fall back to lowercased+trimmed raw (still filterable)', () => {
  assert.equal(canonicalCategory('Quidditch'), 'quidditch');
  assert.equal(canonicalCategory('  Some New Thing  '), 'some new thing');
});

test('null / blank → empty string', () => {
  assert.equal(canonicalCategory(null), '');
  assert.equal(canonicalCategory(undefined), '');
  assert.equal(canonicalCategory(''), '');
  assert.equal(canonicalCategory('   '), '');
});

test('the canonical bucket set is deduped (no EN/plural/case dups)', () => {
  // The realistic 41-value vocabulary measured on the live feed must collapse to a
  // small clean set of RU keys (no concert+Concert+concerts splits, etc.).
  const realVocab = [
    'concert', 'Концерт', 'концерт', 'Concert', 'Концерты', 'concerts',
    'Музыка', 'music', 'музыка', 'Music', 'Концерты и музыка', 'Музыка и театр', 'jazz', 'Джаз',
    'театр', 'theatre', 'Балет',
    'выставка', 'Выставка', 'exhibition', 'выставка / корабль-музей',
    'Кино', 'cinema', 'кино',
    'Праздник', 'праздник', 'Праздники', 'festival', 'Festival', 'фестиваль', 'Гастрономический фестиваль', 'gastronomy', 'fireworks',
    'Развлечения', 'развлечения', 'Entertainment', 'show',
    'Лекция', 'Stand-up', 'культура', 'culture',
  ];
  const keys = new Set(realVocab.map(canonicalCategory));
  // 41 raw values must collapse to ~10 clean canonical keys.
  assert.ok(keys.size <= 12, `expected ≤12 canonical keys, got ${keys.size}: ${[...keys].join(', ')}`);
  assert.ok(keys.has('концерт') && keys.has('театр') && keys.has('выставка') && keys.has('кино') && keys.has('фестиваль'));
  // Every key is canonical RU (no raw EN concert/Concert leaking through).
  assert.ok(!keys.has('concert') && !keys.has('Concert') && !keys.has('concerts'));
});

test('categoryLabelRu capitalizes a canonical RU key', () => {
  assert.equal(categoryLabelRu('концерт'), 'Концерт');
  assert.equal(categoryLabelRu('выставка'), 'Выставка');
  assert.equal(categoryLabelRu('кино'), 'Кино');
  assert.equal(categoryLabelRu(''), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';

// T146 — valenciarusa non-event guard + price/venue extraction. Imports the ACTUAL
// pure functions from the normalizer (DB-free: buildValenciarusaEvents skips the
// page_snapshot and never touches the DB). Asserts that nav / contact / legal / chrome
// cards are DROPPED while every real dated listing is KEPT.

import {
  isJunkCard,
  buildValenciarusaEvents,
  parsePrice,
  stripValenciarusaNoise,
} from '../lib/pipeline/normalizers/valenciarusa.ts';

const VR = 'Валенсия Русская';

// Bug 1: the valenciarusa card title leads with a "<МЕС> DD [HH:MM] [N сеансов]
// [от PRICE €]" date/price BOILERPLATE prefix that no other source emits — it must be
// stripped so the emitted title leads with the CORE event name (→ cross-source dedup).
test('stripValenciarusaNoise: removes "<МЕС> DD N сеансов от PRICE €" prefix', () => {
  assert.equal(
    stripValenciarusaNoise('ИЮН 28 2 сеансов от 69 € Oxxxymiron в Валенсии: гастроли «Национальность: нет» в Roig Arena'),
    'Oxxxymiron в Валенсии: гастроли «Национальность: нет» в Roig Arena',
  );
});

test('stripValenciarusaNoise: removes "<МЕС> DD HH:MM от PRICE €" prefix', () => {
  assert.equal(
    stripValenciarusaNoise('ОКТ 03 19:30 от 49 € «Чемодан» в Аликанте: Кортнев, Агранович и Трескунов'),
    '«Чемодан» в Аликанте: Кортнев, Агранович и Трескунов',
  );
});

test('stripValenciarusaNoise: removes bare "<МЕС> DD" prefix', () => {
  assert.equal(
    stripValenciarusaNoise('МАР 18 Виктория Складчикова в Аликанте'),
    'Виктория Складчикова в Аликанте',
  );
});

test('stripValenciarusaNoise: leaves a title without the prefix untouched', () => {
  assert.equal(stripValenciarusaNoise('Pet Shop Boys в Валенсии'), 'Pet Shop Boys в Валенсии');
});

test('stripValenciarusaNoise: empty / nullish input is safe', () => {
  assert.equal(stripValenciarusaNoise(''), null);
  assert.equal(stripValenciarusaNoise(null), null);
});

test('buildValenciarusaEvents: emitted title is the CORE name (noise prefix removed)', () => {
  const rows = [{
    id: 1,
    source_key: 'web:valenciarusa',
    title: 'ИЮН 28 2 сеансов от 69 € Oxxxymiron в Валенсии: гастроли «Национальность: нет» в Roig Arena Auditorio Roig Arena',
    url: 'https://www.valenciarusa.es/sobytiya/oxxxymiron',
    raw_text: 'Oxxxymiron концерт в Roig Arena 28 июня 2026',
    raw_json: '{"kind":"link_card"}',
  }];
  const out = buildValenciarusaEvents(rows, new Date(2026, 5, 20));
  assert.equal(out.length, 1);
  assert.ok(out[0].draft.title.startsWith('Oxxxymiron'), `title should lead with core name, got: ${out[0].draft.title}`);
  assert.ok(!/^ИЮН/.test(out[0].draft.title), 'no leading month-prefix noise');
});

// Helper: a raw source_items row shape (loose, like the live rows).
const card = (id, title, raw_text = title, raw_json = '{"kind":"link_card"}', url = `https://www.valenciarusa.es/sobytiya/x-${id}`) => ({
  id,
  source_key: 'web:valenciarusa',
  title,
  raw_text,
  raw_json,
  url,
});

test('T146 isJunkCard: bare email / mailto card is JUNK', () => {
  assert.equal(isJunkCard('info@valenciarusa.es', 'info@valenciarusa.es', VR), true);
  assert.equal(isJunkCard('mailto:hola@example.com', 'mailto:hola@example.com', VR), true);
});

test('T146 isJunkCard: pure nav / legal labels (RU/UK/ES) are JUNK', () => {
  assert.equal(isJunkCard('Правовая информация', 'Правовая информация', VR), true);
  assert.equal(isJunkCard('Конфиденциальность', 'Конфиденциальность', VR), true);
  assert.equal(isJunkCard('Контакты', 'Контакты', VR), true);
  assert.equal(isJunkCard('Подписаться', 'Подписаться', VR), true);
  assert.equal(isJunkCard('Войти', 'Войти', VR), true);
  assert.equal(isJunkCard('Política de privacidad', 'Política de privacidad', VR), true);
  assert.equal(isJunkCard('Cookies', 'Cookies', VR), true);
});

test('T146 isJunkCard: bare site-name header (with chrome temp suffix) is JUNK', () => {
  assert.equal(isJunkCard(VR, VR, VR), true);
  assert.equal(isJunkCard(VR, 'Валенсия Русская 25 °', VR), true);
});

test('T146 isJunkCard: empty card is JUNK', () => {
  assert.equal(isJunkCard('', '', VR), true);
  assert.equal(isJunkCard(null, null, VR), true);
});

test('T146 isJunkCard: a REAL dated listing is KEPT (not junk)', () => {
  // Mentioning a venue email/contact mid-body must NOT trip the email guard.
  assert.equal(
    isJunkCard(
      'ИЮН 21 от 40 € Слава Комиссаренко в Валенсии: стендап 21 июня 2026 Roig Arena',
      'ИЮН 21 от 40 € Слава Комиссаренко в Валенсии: стендап 21 июня 2026 Roig Arena',
      VR,
    ),
    false,
  );
  // A "cookies" word inside a real event body is fine — only a whole-card label drops.
  assert.equal(
    isJunkCard('Концерт в Валенсии 23 июля, билеты без cookies', 'Концерт в Валенсии 23 июля, билеты без cookies', VR),
    false,
  );
});

test('T146 build: drops email + nav cards, keeps the real dated event', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const rows = [
    card(107, 'ИЮН 21 от 40 € Слава Комиссаренко в Валенсии: стендап 21 июня 2026 Roig Arena'),
    card(126, 'info@valenciarusa.es', 'info@valenciarusa.es', '{"kind":"link_card"}', 'mailto:info@valenciarusa.es'),
    card(127, 'Конфиденциальность'),
    card(128, 'Правовая информация'),
  ];
  const out = buildValenciarusaEvents(rows, today);
  const keptIds = out.map((o) => o.sourceItemId);
  assert.deepEqual(keptIds, [107], 'only the real dated event survives');
  assert.equal(out[0].draft.title.includes('Слава Комиссаренко'), true);
});

test('T146 build: page_snapshot still dropped (existing behaviour stays green)', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const rows = [
    card(106, 'Афиша Валенсии 2026 | Валенсия Русская', 'big chrome blob …', '{"kind":"page_snapshot"}'),
  ];
  assert.equal(buildValenciarusaEvents(rows, today).length, 0);
});

test('parsePrice: existing extraction stays green', () => {
  assert.deepEqual(parsePrice('€10'), { price: '10 €', isFree: 0 });
  assert.deepEqual(parsePrice('билеты 25 eur'), { price: '25 €', isFree: 0 });
  assert.deepEqual(parsePrice('вход свободный'), { price: 'Free', isFree: 1 });
  assert.deepEqual(parsePrice('нет цены'), { price: null, isFree: null });
});

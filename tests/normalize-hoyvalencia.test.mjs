import test from 'node:test';
import assert from 'node:assert/strict';

// Tests for lib/pipeline/normalizers/hoyvalencia.ts (web:hoyvalencia, id 11). Imports
// the REAL pure helpers from the TS module (run via `node --import tsx --test`) so the
// assertions exercise the shipped logic, not a re-implementation. Fixtures are FAITHFUL
// to the live `web:hoyvalencia` raw shape observed in source_items: each event arrives
// as a `link_card` whose `title` (== `raw_text`) is the FLATTENED card text and whose
// `url` is a `hoyvalencia.app/planes/<slug>/` deep link. There is NO ISO datetime — the
// fixed token order is:
//   "[<price-phrase>] <category> <date-phrase> <TITLE> <VENUE> <CITY>"
// with NO delimiters. Dates are Spanish "DD mmm YYYY" / "Hasta el DD mmm YYYY" / relative
// "✱ ¡Solo hoy!" badges / "Fechas disponibles".

import {
  HOYVALENCIA_SOURCE_KEY,
  buildHoyvalenciaEvents,
  parseHoyvalenciaDates,
  parseHoyvalenciaPrice,
  stripHoyvalenciaPrefix,
  stripHoyvalenciaDatePhrase,
  splitHoyvalenciaCity,
  isHoyvalenciaEventUrl,
} from '../lib/pipeline/normalizers/hoyvalencia.ts';

const TODAY = new Date('2026-06-19T00:00:00'); // fixed reference for determinism

// Real rows copied verbatim from the live local DB (ids preserved for traceability).
const lc = (id, url, title) => ({
  id,
  source_key: 'web:hoyvalencia',
  item_type: 'mixed',
  url,
  title,
  raw_text: title, // generic web parser sets raw_text == title for these cards
  raw_json: JSON.stringify({ kind: 'link_card', source_page: 'https://www.hoyvalencia.app/que-hacer-este-fin-de-semana-en-valencia/' }),
});

const ROWS = [
  // page snapshot — must be dropped
  {
    id: 389,
    source_key: 'web:hoyvalencia',
    item_type: 'snapshot',
    url: 'https://www.hoyvalencia.app/que-hacer-este-fin-de-semana-en-valencia/',
    title: 'Qué hacer este fin de semana en Valencia – Hoy Valencia',
    raw_text: 'Qué hacer este fin de semana en Valencia – Hoy Valencia …',
    raw_json: JSON.stringify({ kind: 'page_snapshot', meta: { title: 'Qué hacer …' } }),
  },
  // category-nav anchors (#planes / custom-date picker) — must be dropped
  lc(390, 'https://www.hoyvalencia.app/planes-teatro-y-espectaculos-este-fin-de-semana-en-valencia/#planes', 'Teatro y espectáculos'),
  lc(393, 'https://www.hoyvalencia.app/que-hacer-fecha-personalizada-en-valencia/', 'Fecha personalizada'),
  // real /planes/ listings
  lc(397, 'https://www.hoyvalencia.app/planes/exposicion-la-naturaleza-de-las-cosas-las-atarazanas-valencia/',
    "Gratis Exposiciones Hasta el 27 jun 2026 Exposición 'La Naturaleza de las Cosas' Las Atarazanas Valencia"),
  lc(402, 'https://www.hoyvalencia.app/planes/suenos-en-escena-burlesque-teatre-talia-valencia/',
    '¡Oferta con descuento! Desde 5.6 € Teatro y espectáculos 19 jun 2026 Sueños En Escena + Burlesque Teatre Talia València'),
  lc(411, 'https://www.hoyvalencia.app/planes/miguel-poveda-plaza-de-toros-de-valencia/',
    '¡Oferta con descuento! Desde 49.5 € Conciertos ✱ ¡Solo hoy! Miguel Poveda Plaza de Toros de Valencia València'),
  lc(409, 'https://www.hoyvalencia.app/planes/podria-ser-peor-un-monologo-de-sergio-alamar-a-concretar-valencia/',
    '¡Oferta con descuento! Desde 10 € Monólogos Fechas disponibles PODRÍA SER PEOR - Un monólogo de Sergio Alamar Valencia'),
  lc(422, 'https://www.hoyvalencia.app/planes/kata-lidoscopi-jardin-botanico-cullera/',
    'Desde 25 € Otros 19 jun 2026 Kata-lidoscopi Jardín Botánico Cullera'),
  lc(413, 'https://www.hoyvalencia.app/planes/albert-sanz-canciones-sin-palabras-sala-matisse-valencia/',
    '¡Oferta con descuento! Desde 12 € Conciertos ✱ ¡Solo mañana! Albert Sanz - Canciones sin palabras Sala Matisse València'),
  lc(396, 'https://www.hoyvalencia.app/planes/actividades-centro-cultural-bancaja-valencia/',
    'Consultar precio Charlas y talleres Hasta el 3 oct 2026 Actividades Centro Cultural Bancaja Valencia'),
];

test('source key matches sources.json (web:hoyvalencia)', () => {
  assert.equal(HOYVALENCIA_SOURCE_KEY, 'web:hoyvalencia');
});

test('isHoyvalenciaEventUrl: only /planes/<slug>/ are events', () => {
  assert.equal(isHoyvalenciaEventUrl('https://www.hoyvalencia.app/planes/miguel-poveda-plaza-de-toros-de-valencia/'), true);
  assert.equal(isHoyvalenciaEventUrl('https://www.hoyvalencia.app/planes-teatro-y-espectaculos-este-fin-de-semana-en-valencia/#planes'), false);
  assert.equal(isHoyvalenciaEventUrl('https://www.hoyvalencia.app/que-hacer-fecha-personalizada-en-valencia/'), false);
  assert.equal(isHoyvalenciaEventUrl(''), false);
  assert.equal(isHoyvalenciaEventUrl(null), false);
});

test('parseHoyvalenciaPrice: Gratis / Desde NN € / Consultar precio', () => {
  assert.deepEqual(parseHoyvalenciaPrice('Gratis Exposiciones …'), { price: 'Free', isFree: 1 });
  assert.deepEqual(parseHoyvalenciaPrice('¡Oferta con descuento! Desde 5.6 € …'), { price: '€ 5.6', isFree: 0 });
  assert.deepEqual(parseHoyvalenciaPrice('Desde 49.5 € Conciertos …'), { price: '€ 49.5', isFree: 0 });
  // comma decimal normalised to a dot
  assert.deepEqual(parseHoyvalenciaPrice('Desde 14,25 € …'), { price: '€ 14.25', isFree: 0 });
  // price on request → null, not invented
  assert.deepEqual(parseHoyvalenciaPrice('Consultar precio Conciertos …'), { price: null, isFree: null });
});

test('parseHoyvalenciaDates: single "DD mmm YYYY" → start_date', () => {
  const r = parseHoyvalenciaDates('… Teatro y espectáculos 19 jun 2026 Sueños En Escena …', TODAY);
  assert.equal(r.start, '2026-06-19');
  assert.equal(r.end, null);
});

test('parseHoyvalenciaDates: "Hasta el DD mmm YYYY" → end_date only (ongoing run)', () => {
  const r = parseHoyvalenciaDates("Gratis Exposiciones Hasta el 27 jun 2026 Exposición 'La Naturaleza …' …", TODAY);
  assert.equal(r.start, null, '"Hasta el" is an end date, not a start');
  assert.equal(r.end, '2026-06-27');
});

test('T196 parseHoyvalenciaDates: "Del DD al DD mmm YYYY" range → start + end', () => {
  const r = parseHoyvalenciaDates('… Teatro y espectáculos ✱ Del 25 jun 2026 al 28 jun 2026 Carmina Burana …', TODAY);
  assert.equal(r.start, '2026-06-25');
  assert.equal(r.end, '2026-06-28');
  // a range spanning months keeps both ends
  const r2 = parseHoyvalenciaDates('… Del 28 jun 2026 al 3 oct 2026 Hamblet …', TODAY);
  assert.equal(r2.start, '2026-06-28');
  assert.equal(r2.end, '2026-10-03');
});

test('T196 parseHoyvalenciaDates: collapsed "Del al DD mmm YYYY" → end only, no phantom start', () => {
  // the flattened card sometimes drops the start cell ("Del al 28 jun 2026"); the cell
  // after "al" is the END, and we must NOT read it as a lone start_date.
  const r = parseHoyvalenciaDates('… Teatro y espectáculos ✱ Del al 28 jun 2026 Carmina Burana …', TODAY);
  assert.equal(r.start, null);
  assert.equal(r.end, '2026-06-28');
});

test('parseHoyvalenciaDates: relative badges → today / tomorrow', () => {
  assert.equal(parseHoyvalenciaDates('… Conciertos ✱ ¡Solo hoy! Miguel Poveda …', TODAY).start, '2026-06-19');
  assert.equal(parseHoyvalenciaDates('… ✱ ¡Termina hoy! …', TODAY).start, '2026-06-19');
  assert.equal(parseHoyvalenciaDates('… Conciertos ✱ ¡Solo mañana! Albert Sanz …', TODAY).start, '2026-06-20');
  assert.equal(parseHoyvalenciaDates('… ✱ ¡Termina mañana! …', TODAY).start, '2026-06-20');
});

test('parseHoyvalenciaDates: "Fechas disponibles" / nothing → null (undated, not guessed)', () => {
  assert.deepEqual(parseHoyvalenciaDates('… Monólogos Fechas disponibles PODRÍA SER PEOR …', TODAY), { start: null, end: null });
  assert.deepEqual(parseHoyvalenciaDates('', TODAY), { start: null, end: null });
});

test('stripHoyvalenciaPrefix: peels stacked price-phrase + category badge', () => {
  const a = stripHoyvalenciaPrefix('¡Oferta con descuento! Desde 5.6 € Teatro y espectáculos 19 jun 2026 Sueños En Escena + Burlesque Teatre Talia València');
  assert.equal(a.category, 'Teatro y espectáculos');
  assert.equal(a.head, '19 jun 2026 Sueños En Escena + Burlesque Teatre Talia València');
  const b = stripHoyvalenciaPrefix('Gratis Exposiciones Hasta el 27 jun 2026 X Las Atarazanas Valencia');
  assert.equal(b.category, 'Exposiciones');
  assert.equal(b.head, 'Hasta el 27 jun 2026 X Las Atarazanas Valencia');
});

test('stripHoyvalenciaDatePhrase: removes the leading date-phrase, leaves title+venue+city', () => {
  assert.equal(stripHoyvalenciaDatePhrase('Hasta el 27 jun 2026 Exposición X Las Atarazanas Valencia'),
    'Exposición X Las Atarazanas Valencia');
  assert.equal(stripHoyvalenciaDatePhrase('19 jun 2026 Sueños En Escena Teatre Talia València'),
    'Sueños En Escena Teatre Talia València');
  assert.equal(stripHoyvalenciaDatePhrase('✱ ¡Solo hoy! Miguel Poveda Plaza de Toros de Valencia València'),
    'Miguel Poveda Plaza de Toros de Valencia València');
  assert.equal(stripHoyvalenciaDatePhrase('Fechas disponibles PODRÍA SER PEOR Valencia'),
    'PODRÍA SER PEOR Valencia');
});

test('T196 stripHoyvalenciaDatePhrase: removes the whole "Del … al …" range (no remnant)', () => {
  assert.equal(
    stripHoyvalenciaDatePhrase('Del 25 jun 2026 al 28 jun 2026 Carmina Burana Palau de Les Arts Reina Sofia València'),
    'Carmina Burana Palau de Les Arts Reina Sofia València',
  );
  // collapsed-start variant: "Del al 28 jun 2026 …" → range removed, no "Del al" left over
  const stripped = stripHoyvalenciaDatePhrase('✱ Del al 28 jun 2026 LIMBUS Teatro Círculo');
  assert.equal(stripped, 'LIMBUS Teatro Círculo');
  assert.ok(!/^Del\b/.test(stripped), 'no leading "Del" remnant');
});

test('splitHoyvalenciaCity: trailing town → city, rest is title; València→Valencia', () => {
  assert.deepEqual(splitHoyvalenciaCity('Sueños En Escena Teatre Talia València'),
    { title: 'Sueños En Escena Teatre Talia', city: 'Valencia' });
  assert.deepEqual(splitHoyvalenciaCity('Kata-lidoscopi Jardín Botánico Cullera'),
    { title: 'Kata-lidoscopi Jardín Botánico', city: 'Cullera' });
  // unknown last token → city defaults to Valencia, whole head kept as title
  assert.deepEqual(splitHoyvalenciaCity('Some Event Somewhere'),
    { title: 'Some Event Somewhere', city: 'Valencia' });
});

test('buildHoyvalenciaEvents: drops snapshot + nav, keeps /planes/ listings', () => {
  const out = buildHoyvalenciaEvents(ROWS, TODAY);
  // 7 real /planes/ rows in the fixture; 3 dropped (snapshot + 2 nav anchors)
  assert.equal(out.length, 7);
  const ids = out.map((o) => o.sourceItemId).sort((a, b) => a - b);
  assert.deepEqual(ids, [396, 397, 402, 409, 411, 413, 422]);
});

test('buildHoyvalenciaEvents: full draft for a single-dated row (402)', () => {
  const out = buildHoyvalenciaEvents(ROWS, TODAY);
  const d = out.find((o) => o.sourceItemId === 402).draft;
  assert.equal(d.title, 'Sueños En Escena + Burlesque Teatre Talia');
  assert.equal(d.start_date, '2026-06-19');
  assert.equal(d.end_date, null);
  assert.equal(d.city, 'Valencia');
  assert.equal(d.country, 'Spain');
  assert.equal(d.price, '€ 5.6');
  assert.equal(d.is_free, 0);
  assert.equal(d.category, 'theatre');
  assert.equal(d.source, 'web:hoyvalencia');
  assert.equal(d.url, 'https://www.hoyvalencia.app/planes/suenos-en-escena-burlesque-teatre-talia-valencia/');
});

test('buildHoyvalenciaEvents: "Hasta el" row → end_date, no start (397)', () => {
  const out = buildHoyvalenciaEvents(ROWS, TODAY);
  const d = out.find((o) => o.sourceItemId === 397).draft;
  assert.equal(d.start_date, null);
  assert.equal(d.end_date, '2026-06-27');
  assert.equal(d.price, 'Free');
  assert.equal(d.is_free, 1);
  assert.equal(d.category, 'exhibition');
  assert.match(d.title, /Naturaleza de las Cosas/);
});

test('buildHoyvalenciaEvents: relative "¡Solo hoy!" row → today (411)', () => {
  const out = buildHoyvalenciaEvents(ROWS, TODAY);
  const d = out.find((o) => o.sourceItemId === 411).draft;
  assert.equal(d.start_date, '2026-06-19');
  assert.equal(d.title, 'Miguel Poveda Plaza de Toros de Valencia');
  assert.equal(d.city, 'Valencia');
  assert.equal(d.category, 'concert');
});

test('buildHoyvalenciaEvents: town outside Valencia kept as city (422 → Cullera)', () => {
  const out = buildHoyvalenciaEvents(ROWS, TODAY);
  const d = out.find((o) => o.sourceItemId === 422).draft;
  assert.equal(d.city, 'Cullera');
  assert.equal(d.title, 'Kata-lidoscopi Jardín Botánico');
  assert.equal(d.price, '€ 25');
  assert.equal(d.start_date, '2026-06-19');
});

test('T196 buildHoyvalenciaEvents: "Del … al …" range row → clean title + start & end', () => {
  const row = lc(500, 'https://www.hoyvalencia.app/planes/carmina-burana-palau-de-les-arts/',
    '¡Oferta con descuento! Desde 61 € Teatro y espectáculos ✱ Del 25 jun 2026 al 28 jun 2026 Carmina Burana Palau de Les Arts Reina Sofia València');
  const out = buildHoyvalenciaEvents([row], TODAY);
  assert.equal(out.length, 1);
  const d = out[0].draft;
  assert.equal(d.title, 'Carmina Burana Palau de Les Arts Reina Sofia');
  assert.equal(d.start_date, '2026-06-25');
  assert.equal(d.end_date, '2026-06-28');
  assert.equal(d.city, 'Valencia');
  assert.ok(!/^Del\b/.test(d.title), 'title is not prefixed with the date range');
});

test('T196 buildHoyvalenciaEvents: collapses SAME-source duplicate (two Carmina cards → one)', () => {
  const a = lc(501, 'https://www.hoyvalencia.app/planes/carmina-burana-a/',
    '¡Oferta con descuento! Desde 61 € Teatro y espectáculos ✱ Del 25 jun 2026 al 28 jun 2026 Carmina Burana Palau de Les Arts Reina Sofia València');
  // same show, different price tier + inconsistent venue spelling (Sofía vs Sofia / Les vs les)
  const b = lc(502, 'https://www.hoyvalencia.app/planes/carmina-burana-b/',
    'Consultar precio Teatro y espectáculos ✱ Del 25 jun 2026 al 28 jun 2026 Carmina Burana Palau de les Arts Reina Sofía Valencia');
  const out = buildHoyvalenciaEvents([a, b], TODAY);
  assert.equal(out.length, 1, 'the second identical-title+start card is dropped');
  assert.equal(out[0].sourceItemId, 501, 'the first occurrence is kept');
});

test('buildHoyvalenciaEvents: "Fechas disponibles" → undated draft still emitted (409)', () => {
  const out = buildHoyvalenciaEvents(ROWS, TODAY);
  const d = out.find((o) => o.sourceItemId === 409).draft;
  assert.equal(d.start_date, null);
  assert.equal(d.end_date, null);
  assert.match(d.title, /PODRÍA SER PEOR/);
  assert.equal(d.category, 'comedy');
});

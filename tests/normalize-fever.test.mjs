import test from 'node:test';
import assert from 'node:assert/strict';

// T151 — tests for lib/pipeline/normalizers/fever.ts. Imports the REAL pure helpers
// from the TS module (run via `node --import tsx --test`) so the assertions exercise
// the shipped logic, not a re-implementation. Fixtures are faithful to the live
// `web:fever` raw shape observed in source_items: each event arrives as a `link_card`
// whose `title` (== `raw_text`) is the FLATTENED card text and whose `url` is a
// `feverup.com/m/<id>` deep link. There is NO ISO datetime — dates are Spanish
// abbreviations like "4 jul" / "5 dic - 6 feb".

import {
  FEVER_SOURCE_KEY,
  buildFeverEvents,
  parseFeverDates,
  parseFeverPrice,
  splitFeverVenue,
  feverHead,
} from '../lib/pipeline/normalizers/fever.ts';

const TODAY = new Date('2026-06-21T00:00:00Z'); // fixed reference for determinism

// Real-shape fixtures lifted verbatim from live source_items rows.
const link = (id, title, url, kind = 'link_card') => ({
  id,
  source_key: 'web:fever',
  title,
  url,
  raw_text: title,
  raw_json: JSON.stringify({ kind, source_page: 'https://feverup.com/es/valencia' }),
});

test('source key matches sources.json (web:fever)', () => {
  assert.equal(FEVER_SOURCE_KEY, 'web:fever');
});

test('parseFeverDates: single Spanish date "4 jul" → ISO, year inferred next-occurrence', () => {
  assert.deepEqual(parseFeverDates('Candlelight 4 jul Desde 17,50 €', TODAY), {
    start: '2026-07-04',
    end: null,
  });
});

test('parseFeverDates: a year-less month already passed rolls to next year', () => {
  // today is 2026-06-21; "1 ago" is ahead → 2026; but a past month rolls forward
  assert.deepEqual(parseFeverDates('1 ago', TODAY), { start: '2026-08-01', end: null });
  assert.deepEqual(parseFeverDates('4 may', TODAY), { start: '2027-05-04', end: null });
});

test('parseFeverDates: range "5 dic - 6 feb" wraps the end into next year', () => {
  assert.deepEqual(parseFeverDates('Candlelight 5 dic - 6 feb Desde 21,00 €', TODAY), {
    start: '2026-12-05',
    end: '2027-02-06',
  });
});

test('parseFeverDates: range within the same year keeps the start year', () => {
  assert.deepEqual(parseFeverDates('19 sept - 14 nov Desde 32,00 €', TODAY), {
    start: '2026-09-19',
    end: '2026-11-14',
  });
});

test('parseFeverDates: 4-letter "sept" abbreviation parses as September', () => {
  assert.deepEqual(parseFeverDates('5 sept', TODAY), { start: '2026-09-05', end: null });
});

test('parseFeverDates: no date cell → nulls', () => {
  assert.deepEqual(parseFeverDates('Zevra Festival 2026', TODAY), { start: null, end: null });
  assert.deepEqual(parseFeverDates('', TODAY), { start: null, end: null });
});

test('parseFeverPrice: "Desde 17,50 €" → "€ 17.50"; takes the leading price on a discount', () => {
  assert.equal(parseFeverPrice('... 4 jul - 27 mar Desde 17,50 €'), '€ 17.50');
  assert.equal(parseFeverPrice('Dalia Gutmann 6 nov 25,00 € 22,00 €'), '€ 25.00');
  assert.equal(parseFeverPrice('no price here'), null);
});

test('splitFeverVenue: peels a known Valencia venue off the head', () => {
  assert.deepEqual(
    splitFeverVenue('Ateneo Mercantil de Valencia Candlelight: Tributo a Ludovico Einaudi'),
    { venue: 'Ateneo Mercantil de Valencia', title: 'Candlelight: Tributo a Ludovico Einaudi' },
  );
  // unknown leading phrase → whole head is the title, venue null (never guessed)
  assert.deepEqual(
    splitFeverVenue('La leyenda del Titanic. La exposición definitiva en Bombas Gens'),
    { venue: null, title: 'La leyenda del Titanic. La exposición definitiva en Bombas Gens' },
  );
});

test('feverHead: strips rating/date/price tail and the top-10 rank prefix', () => {
  assert.equal(
    feverHead('Ateneo Mercantil de Valencia Candlelight: Tributo a Mecano 4.6 (155) 27 nov Desde 18,50 €'),
    'Ateneo Mercantil de Valencia Candlelight: Tributo a Mecano',
  );
  assert.equal(feverHead('1 1 Spain Sail Grand Prix | Valencia 2026'), 'Spain Sail Grand Prix | Valencia 2026');
});

test('buildFeverEvents: extracts correct title, start_date, venue and price from a real card', () => {
  const rows = [
    link(
      342,
      'Ateneo Mercantil de Valencia Candlelight: Tributo a Ludovico Einaudi 4.7 (469) 4 jul - 27 mar Desde 17,50 €',
      'https://feverup.com/m/91420',
    ),
  ];
  const out = buildFeverEvents(rows, TODAY);
  assert.equal(out.length, 1);
  const { draft, sourceItemId } = out[0];
  assert.equal(sourceItemId, 342);
  assert.equal(draft.title, 'Candlelight: Tributo a Ludovico Einaudi'); // venue stripped off
  assert.equal(draft.venue_name, 'Ateneo Mercantil de Valencia');
  assert.equal(draft.start_date, '2026-07-04'); // ISO from "4 jul"
  assert.equal(draft.end_date, '2027-03-27'); // range end "27 mar" wraps to next year
  assert.equal(draft.price, '€ 17.50');
  assert.equal(draft.city, 'Valencia');
  assert.equal(draft.country, 'Spain');
  assert.equal(draft.source, 'web:fever');
  assert.equal(draft.url, 'https://feverup.com/m/91420');
});

test('buildFeverEvents: emits an undated real event (top-10 card, no date in text)', () => {
  const rows = [link(334, '3 3 La leyenda del Titanic. La exposición definitiva en Bombas Gens', 'https://feverup.com/m/522272')];
  const out = buildFeverEvents(rows, TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.title, 'La leyenda del Titanic. La exposición definitiva en Bombas Gens');
  assert.equal(out[0].draft.start_date, null); // no date in card text → null, still emitted
  assert.equal(out[0].draft.venue_name, null);
});

test('buildFeverEvents: drops category-nav anchors, the page snapshot, and gift cards', () => {
  const rows = [
    // category nav anchor (no /m/ id)
    link(311, 'Conciertos Candlelight', 'https://feverup.com/es/valencia/candlelight'),
    // page snapshot (whole listing page)
    link(308, 'Planes en Valencia: Eventos y cosas que hacer | Fever', 'https://feverup.com/es/valencia', 'page_snapshot'),
    // gift card product
    link(379, '¡Gracias! - Tarjeta regalo Special Edition Desde 20,00 €', 'https://feverup.com/m/326183'),
    // waitlist
    link(349, 'The Chocolate Factory: adéntrate en el mundo más dulce - Lista de Espera', 'https://feverup.com/m/110918'),
  ];
  const out = buildFeverEvents(rows, TODAY);
  assert.equal(out.length, 0);
});

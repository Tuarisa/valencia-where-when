import test from 'node:test';
import assert from 'node:assert/strict';

// T112-family — visitvalencia.com (web:visitvalencia) normalizer. Imports the ACTUAL
// pure functions (DB-free: buildVisitvalenciaEvents skips the page_snapshot and never
// touches the DB). Fixtures are FAITHFUL to the real live rows observed in
// source_items: each event card's `title` == `raw_text` (title only, NO body, NO
// date), `raw_json` is a bare `{"kind":"link_card",...}` (no meta/og:image), and the
// detail URL is `/en/events-valencia/<slug>` (descriptive slug, NO date). The listing
// also spills nav / `/shop/` / `/plan-your-trip/` chrome + the `music`/`festivities`
// category indices — those MUST be dropped.

import {
  VISITVALENCIA_SOURCE_KEY,
  isVisitvalenciaEventUrl,
  classifyVisitvalencia,
  buildVisitvalenciaEvents,
} from '../lib/pipeline/normalizers/visitvalencia.ts';

const BASE = 'https://www.visitvalencia.com/en/events-valencia';

// Helper: a raw source_items row shape (loose, like the live rows). For visitvalencia
// the real cards have raw_text == title and a bare link_card raw_json.
const card = (id, title, slug) => ({
  id,
  source_key: 'web:visitvalencia',
  title,
  raw_text: title,
  raw_json: '{"kind":"link_card","source_page":"https://www.visitvalencia.com/en/events-valencia"}',
  url: `${BASE}/${slug}`,
});

// A raw chrome/nav card whose URL is NOT an event detail page.
const chrome = (id, title, url) => ({
  id,
  source_key: 'web:visitvalencia',
  title,
  raw_text: title,
  raw_json: '{"kind":"link_card","source_page":"https://www.visitvalencia.com/en/events-valencia"}',
  url,
});

// Today pinned so any date inference is deterministic (none expected — no dates).
const TODAY = new Date('2026-06-21T00:00:00Z');

test('source key matches sources.json (web:visitvalencia, id 13)', () => {
  assert.equal(VISITVALENCIA_SOURCE_KEY, 'web:visitvalencia');
});

test('isVisitvalenciaEventUrl: real /events-valencia/<slug> detail pages are events', () => {
  assert.equal(isVisitvalenciaEventUrl(`${BASE}/immersive-exhibition-legend-titanic-valencia`), true);
  assert.equal(isVisitvalenciaEventUrl(`${BASE}/anselm-kiefers-exhibition-comes-valencia`), true);
  // trailing slash and query/hash are tolerated
  assert.equal(isVisitvalenciaEventUrl(`${BASE}/playmobil-2026-exhibition-military-history-museum-valencia/`), true);
  assert.equal(isVisitvalenciaEventUrl(`${BASE}/enjoy-best-live-flamenco?utm=x`), true);
});

test('isVisitvalenciaEventUrl: category indices + chrome + shop are NOT events', () => {
  assert.equal(isVisitvalenciaEventUrl(`${BASE}/music`), false);          // category index
  assert.equal(isVisitvalenciaEventUrl(`${BASE}/festivities`), false);    // category index
  assert.equal(isVisitvalenciaEventUrl(`${BASE}`), false);                // bare index
  assert.equal(isVisitvalenciaEventUrl(`${BASE}#main-content`), false);   // skip-link anchor
  assert.equal(isVisitvalenciaEventUrl('https://www.visitvalencia.com/en/shop/hop-on-hop-off-bus-tour'), false);
  assert.equal(isVisitvalenciaEventUrl('https://www.visitvalencia.com/en/plan-your-trip-to-valencia/tourism-office'), false);
  assert.equal(isVisitvalenciaEventUrl('https://www.visitvalencia.com/en/what-to-see-valencia/museums-monuments'), false);
  assert.equal(isVisitvalenciaEventUrl(null), false);
  assert.equal(isVisitvalenciaEventUrl(undefined), false);
});

test('classifyVisitvalencia: deterministic keyword categories', () => {
  assert.equal(classifyVisitvalencia('Anselm Kiefer’s exhibition comes to Valencia'), 'exhibition');
  assert.equal(classifyVisitvalencia('Mediterranean Guitar concert series in Valencia'), 'concert');
  assert.equal(classifyVisitvalencia('Macromascletà Universal de Benicalap 2026: gunpowder'), 'festival');
  assert.equal(classifyVisitvalencia('Learn how to cook paella in Valencia'), 'experience');
  assert.equal(classifyVisitvalencia('Valencia Club de Fútbol matches at Mestalla'), 'sports');
  // unknown headline falls back to the generic culture agenda label
  assert.equal(classifyVisitvalencia('A lovely afternoon in Valencia'), 'culture');
});

test('buildVisitvalenciaEvents: keeps real event cards, drops the snapshot + nav + category', () => {
  const rows = [
    // the page snapshot row (kind=page_snapshot) — must be dropped
    {
      id: 715,
      source_key: 'web:visitvalencia',
      title: 'Valencia Events | Events in Valencia | Upcoming Events',
      raw_text: 'Valencia Events | Events in Valencia | Upcoming Events Skip to main content',
      raw_json: '{"kind":"page_snapshot","meta":{"og:image":"https://x/og.jpg"}}',
      url: BASE,
    },
    chrome(716, 'Skip to main content', `${BASE}#main-content`),
    chrome(732, 'Hop-on hop-off bus', 'https://www.visitvalencia.com/en/shop/hop-on-hop-off-bus-tour'),
    chrome(727, 'Concerts and music festivals in Valencia', `${BASE}/music`),     // category index
    chrome(728, 'Festivities and traditions', `${BASE}/festivities`),             // category index
    // real event detail cards (title == raw_text, no date, descriptive slug)
    card(741, "Anselm Kiefer's exhibition comes to Valencia", 'anselm-kiefers-exhibition-comes-valencia'),
    card(745, 'Immersive Exhibition “The Legend of the Titanic” in Valencia', 'immersive-exhibition-legend-titanic-valencia'),
    card(778, '«Alegría - In A New Light» by Cirque du Soleil lands in Valencia', 'alegria-new-light-cirque-du-soleil-lands-valencia'),
  ];

  const out = buildVisitvalenciaEvents(rows, TODAY);
  // exactly the 3 real event cards survive
  assert.equal(out.length, 3);
  const ids = out.map((o) => o.sourceItemId).sort((a, b) => a - b);
  assert.deepEqual(ids, [741, 745, 778]);

  const titanic = out.find((o) => o.sourceItemId === 745).draft;
  assert.equal(titanic.title, 'Immersive Exhibition “The Legend of the Titanic” in Valencia');
  assert.equal(titanic.source, 'web:visitvalencia');
  assert.equal(titanic.city, 'Valencia');
  assert.equal(titanic.country, 'Spain');
  assert.equal(titanic.language, 'en');
  assert.equal(titanic.category, 'exhibition');
  assert.equal(titanic.url, `${BASE}/immersive-exhibition-legend-titanic-valencia`);
  // the source carries NO date → start_date is null (we never fabricate one)
  assert.equal(titanic.start_date, null);
});

test('buildVisitvalenciaEvents: a card that DOES carry a real text date is parsed', () => {
  // synthetic — faithful to the rare case where a headline embeds a real date.
  const row = card(
    999,
    'Open-air cinema night on 16 July in Valencia',
    'open-air-cinema-night-valencia',
  );
  const out = buildVisitvalenciaEvents([row], TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, '2026-07-16');
});

test('buildVisitvalenciaEvents: a year in the title is NOT treated as a date', () => {
  // "Playmobil 2026" — the year is part of the NAME, not a start_date.
  const row = card(
    763,
    'Playmobil 2026 Exhibition at the Military History Museum in Valencia',
    'playmobil-2026-exhibition-military-history-museum-valencia',
  );
  const out = buildVisitvalenciaEvents([row], TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, null);
  assert.equal(out[0].draft.category, 'exhibition');
});

test('buildVisitvalenciaEvents: empty input yields no drafts', () => {
  assert.deepEqual(buildVisitvalenciaEvents([], TODAY), []);
});

// REAL-DATA REGRESSION (measured 2026-06-21 on the live local DB): the crawled
// `web:visitvalencia` snapshot is 81 raw rows → 56 event drafts → 0 dated. This
// reproduces the symptom and pins the HONEST finding: the source link_cards carry
// ONLY a headline (title == raw_text), no body, no meta, no date — and the slug is
// descriptive (no -YYYY-MM-DD). So `start_date` is legitimately NULL on EVERY row;
// fabricating one from a bare year would be wrong (T140 / constitution: a wrong pin
// is worse than none). The fixture below mirrors the real chrome/event mix.
test('buildVisitvalenciaEvents: real-shape mix → drops chrome, keeps events, 0 dated', () => {
  const rows = [
    // 1 page snapshot (the index itself)
    {
      id: 715,
      source_key: 'web:visitvalencia',
      title: 'Valencia Events | Events in Valencia | Upcoming Events',
      raw_text: 'Valencia Events | Events in Valencia | Upcoming Events Skip to main content',
      raw_json: '{"kind":"page_snapshot","source_page":"https://www.visitvalencia.com/en/events-valencia"}',
      url: BASE,
    },
    // chrome: skip-link anchor, bare index, /shop, /plan-your-trip, /what-to-see, /what-to-do
    chrome(716, 'Skip to main content', `${BASE}#main-content`),
    chrome(717, 'How to get to Valencia', 'https://www.visitvalencia.com/en/plan-your-trip-to-valencia/to-get-to-valencia'),
    chrome(722, 'Albufera natural park', 'https://www.visitvalencia.com/en/what-to-see-valencia/albufera-natural-park'),
    chrome(726, 'Valencia with kids', 'https://www.visitvalencia.com/en/what-to-do-valencia/valencia-for-children'),
    chrome(732, 'Hop-on hop-off bus', 'https://www.visitvalencia.com/en/shop/hop-on-hop-off-bus-tour'),
    // category indices under /events-valencia/ — listing pages, NOT single events
    chrome(727, 'Concerts and music festivals in Valencia', `${BASE}/music`),
    chrome(728, 'Festivities and traditions', `${BASE}/festivities`),
    // real event-detail cards (title == raw_text, bare link_card json, no date)
    card(741, "Anselm Kiefer's exhibition comes to Valencia", 'anselm-kiefers-exhibition-comes-valencia'),
    card(745, 'Immersive Exhibition “The Legend of the Titanic” in Valencia', 'immersive-exhibition-legend-titanic-valencia'),
    card(763, 'Playmobil 2026 Exhibition at the Military History Museum in Valencia', 'playmobil-2026-exhibition-military-history-museum-valencia'),
    card(794, 'Macromascletà Universal de Benicalap 2026: gunpowder, DJs and open-air party', 'macromascleta-universal-de-benicalap-2026-gunpowder-djs-and-open-air-party'),
    // borderline "ongoing experience / listicle" cards — these ARE real agenda
    // entries on the official events page (evergreen), so they are KEPT, not chrome.
    card(756, 'The Best Spas in Valencia to Disconnect and Recharge', 'best-spas-valencia-disconnect-and-recharge'),
    card(768, 'Three ways to enjoy live jazz in Valencia', 'three-ways-enjoy-live-jazz-valencia'),
  ];

  const out = buildVisitvalenciaEvents(rows, TODAY);
  // 6 real event cards survive (741, 745, 763, 794, 756, 768); the snapshot, the 6
  // chrome rows and the 2 category indices are all dropped.
  assert.equal(out.length, 6);
  const ids = out.map((o) => o.sourceItemId).sort((a, b) => a - b);
  assert.deepEqual(ids, [741, 745, 756, 763, 768, 794]);
  // HONEST FINDING: not one survivor carries a parseable date — the data has none.
  const dated = out.filter((o) => o.draft.start_date !== null);
  assert.equal(dated.length, 0);
  // every survivor still carries the city/country/source defaults so it renders.
  for (const { draft } of out) {
    assert.equal(draft.city, 'Valencia');
    assert.equal(draft.country, 'Spain');
    assert.equal(draft.source, 'web:visitvalencia');
    assert.equal(draft.start_date, null);
  }
});

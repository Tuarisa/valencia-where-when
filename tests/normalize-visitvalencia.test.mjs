import test from 'node:test';
import assert from 'node:assert/strict';

// T112-family — visitvalencia.com (web:visitvalencia) normalizer. Imports the ACTUAL
// pure functions (DB-free). Fixtures are FAITHFUL to the real live rows observed in
// source_items: each event card's `title` == `raw_text` (headline only; since the
// Aug-2026 redesign the six highlight cards glue a trailing "DD/MM/YYYY - DD/MM/YYYY"
// range into that text), `raw_json` is a bare `{"kind":"link_card",...}`, and the
// detail URL is `/en/events-valencia/<slug>` (descriptive slug). The listing also
// spills nav / `/shop/` / `/plan-your-trip/` chrome + the `music`/`festivities`
// category indices — those MUST be dropped. T154: the published dates live in the
// page_snapshot raw_text (three real markups) — snapshot excerpts below are verbatim
// from live rows 1807 (2026-07-05), 1574 (2026-07-02) and 2289 (2026-08-07).

import {
  VISITVALENCIA_SOURCE_KEY,
  isVisitvalenciaEventUrl,
  isVisitvalenciaGuideCard,
  isFullYearPlaceholder,
  classifyVisitvalencia,
  buildVisitvalenciaEvents,
  stripTrailingCardRange,
  scanSnapshotDates,
  extractVisitvalenciaDates,
  lookupSnapshotRange,
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

// REAL-DATA baseline: a batch whose snapshot carries NO date lines (the very first
// 2026-06-21 capture shape). The link_cards alone carry no parseable date, so every
// draft is legitimately NULL-dated — we never fabricate (T140 / constitution: a wrong
// pin is worse than none). The fixture mirrors the real chrome/event mix. (The dated
// path — snapshot ranges + glued card ranges — is covered by the T154 tests below.)
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
    // guide/listicle ARTICLES wearing event URLs (real live rows) — dropped as
    // NON-events since T206 (they bridged false contain-merges in T202).
    card(756, 'The Best Spas in Valencia to Disconnect and Recharge', 'best-spas-valencia-disconnect-and-recharge'),
    card(768, 'Three ways to enjoy live jazz in Valencia', 'three-ways-enjoy-live-jazz-valencia'),
  ];

  const out = buildVisitvalenciaEvents(rows, TODAY);
  // 4 real event cards survive (741, 745, 763, 794); the snapshot, the 6 chrome
  // rows, the 2 category indices and the 2 guide articles are all dropped.
  assert.equal(out.length, 4);
  const ids = out.map((o) => o.sourceItemId).sort((a, b) => a - b);
  assert.deepEqual(ids, [741, 745, 763, 794]);
  // HONEST FINDING: with no dated snapshot in the batch, no survivor gets a date.
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

// ---------------------------------------------------------------------------
// T154 — dates DO live in the payload (real rows, live local DB, 2026-08-08)
// ---------------------------------------------------------------------------

test('stripTrailingCardRange: peels the Aug-2026 glued range off real card titles', () => {
  // verbatim source_items 2311 + 2315 (title == raw_text)
  const a = stripTrailingCardRange('Summer Amusement Park in Valencia 2026 23/06/2026 - 08/08/2026');
  assert.equal(a.title, 'Summer Amusement Park in Valencia 2026');
  assert.deepEqual(a.range, { start: '2026-06-23', end: '2026-08-08' });

  const b = stripTrailingCardRange('Discover Valencia’s Holy Grail in a unique exhibition at the Almudín 30/10/2025 - 29/10/2026');
  assert.equal(b.title, 'Discover Valencia’s Holy Grail in a unique exhibition at the Almudín');
  assert.deepEqual(b.range, { start: '2025-10-30', end: '2026-10-29' });

  // single-day range collapses end to null (verbatim source_items 2312)
  const c = stripTrailingCardRange('Total solar eclipse in Valencia: August 12, 2026 12/08/2026 - 12/08/2026');
  assert.equal(c.title, 'Total solar eclipse in Valencia: August 12, 2026');
  assert.deepEqual(c.range, { start: '2026-08-12', end: null });

  // a clean headline passes through untouched
  const d = stripTrailingCardRange("Anselm Kiefer's exhibition comes to Valencia");
  assert.equal(d.title, "Anselm Kiefer's exhibition comes to Valencia");
  assert.equal(d.range, null);

  // REGRESSION pin (verbatim source_items 2314): the glued range beats the month-first
  // misparse of "…in August 27/07/2026" (was read as "August 27"). The card itself is a
  // guide article and never becomes an event (T206), but the peel must stay correct.
  const e = stripTrailingCardRange('Exhibitions in València: everything you can see in August 27/07/2026 - 31/08/2026');
  assert.equal(e.title, 'Exhibitions in València: everything you can see in August');
  assert.deepEqual(e.range, { start: '2026-07-27', end: '2026-08-31' });
});

// Verbatim excerpt of live snapshot row 1807 (2026-07-05): the pre-Aug "Monthly
// Highlights" SPLIT form ("From \n date \n to date", with a category tag line above
// the title) followed by the main-listing INLINE form ("From X to Y" one line).
const SNAP_1807 = `
 Monthly Highlights

 exhibitions

 Anselm Kiefer's exhibition comes to Valencia

 From
 28/04/2026
 to 25/10/2026

 Anselm Kiefer's exhibition comes to Valencia

 DATE

 Search

 Cabaret, the musical of the Kit Kat Klub in Valencia

 From 02/07/2026 to 05/07/2026

 Cabaret, the musical of the Kit Kat Klub in Valencia

 «Music and Mathematics» Exhibition at CaixaForum in Valencia

 From 11/12/2025 to 23/08/2026

 «Music and Mathematics» Exhibition at CaixaForum in Valencia
`;

// Verbatim excerpt of live snapshot row 2289 (2026-08-07 redesign): COMPACT form.
const SNAP_2289 = `
 Monthly Highlights

 Summer Amusement Park in Valencia 2026

 23/06/2026 - 08/08/2026

 Exhibitions in València: everything you can see in August

 27/07/2026 - 31/08/2026

 DATE

 Search

 Concerts at Loco Club, Valencia's most eclectic venue

 Concerts at Loco Club, Valencia's most eclectic venue
`;

// Verbatim excerpt of live snapshot row 1574 (2026-07-02): the rare BARE single-date
// line directly under a title.
const SNAP_1574 = `
 Stand-up comedy and comedy nights at the July Fair in Valencia

 From 02/07/2026 to 02/07/2026

 Stand-up comedy and comedy nights at the July Fair in Valencia

 Experience the passion of flamenco at Teatre Talia

 02/07/2026

 Experience the passion of flamenco at Teatre Talia
`;

test('scanSnapshotDates: parses all three real markups + the bare single date', () => {
  const map = new Map();
  scanSnapshotDates(SNAP_1807, map);
  // split form pairs with the title ABOVE it (not the category tag "exhibitions")
  assert.deepEqual(map.get('anselm kiefers exhibition comes to valencia'),
    { start: '2026-04-28', end: '2026-10-25' });
  // inline form, first listing entry — "DATE"/"Search" chrome is never the title
  assert.deepEqual(map.get('cabaret the musical of the kit kat klub in valencia'),
    { start: '2026-07-02', end: '2026-07-05' });
  assert.deepEqual(map.get('music and mathematics exhibition at caixaforum in valencia'),
    { start: '2025-12-11', end: '2026-08-23' });

  scanSnapshotDates(SNAP_2289, map);
  assert.deepEqual(map.get('summer amusement park in valencia 2026'),
    { start: '2026-06-23', end: '2026-08-08' });
  assert.deepEqual(map.get('exhibitions in valencia everything you can see in august'),
    { start: '2026-07-27', end: '2026-08-31' });
  // undated listing entries below "DATE/Search" produce NO entry
  assert.equal(map.has('concerts at loco club valencias most eclectic venue'), false);

  scanSnapshotDates(SNAP_1574, map);
  // "From X to X" single-day → end collapses to null
  assert.deepEqual(map.get('stand up comedy and comedy nights at the july fair in valencia'),
    { start: '2026-07-02', end: null });
  // bare date line under a title
  assert.deepEqual(map.get('experience the passion of flamenco at teatre talia'),
    { start: '2026-07-02', end: null });
});

test('extractVisitvalenciaDates: later snapshot overrides an earlier range per title', () => {
  const snap = (id, text) => ({
    id,
    source_key: 'web:visitvalencia',
    raw_text: text,
    raw_json: '{"kind":"page_snapshot","source_page":"https://www.visitvalencia.com/en/events-valencia"}',
    url: BASE,
  });
  // older capture says 28/04–25/10; a (hypothetical) newer one extends to 30/11 —
  // freshest capture must win. Rows given out of order to prove the id sort.
  const newer = snap(2289, `\n Anselm Kiefer's exhibition comes to Valencia \n\n 28/04/2026 - 30/11/2026\n`);
  const older = snap(1807, SNAP_1807);
  const map = extractVisitvalenciaDates([newer, older]);
  assert.deepEqual(map.get('anselm kiefers exhibition comes to valencia'),
    { start: '2026-04-28', end: '2026-11-30' });
  // titles only the OLDER snapshot dated are kept (a real published range)
  assert.deepEqual(map.get('cabaret the musical of the kit kat klub in valencia'),
    { start: '2026-07-02', end: '2026-07-05' });
});

test('lookupSnapshotRange: exact + conservative containment, no fuzzy overreach', () => {
  const map = new Map();
  scanSnapshotDates(SNAP_1807, map);
  // exact normalized-title hit (punctuation/accents fold away)
  assert.deepEqual(lookupSnapshotRange("Anselm Kiefer's exhibition comes to Valencia", map),
    { start: '2026-04-28', end: '2026-10-25' });
  // REAL miss we accept: the Aug listing renamed Playmobil's venue ("Military
  // Historical Museum of València" vs the dated "Military History Museum in
  // Valencia") — neither normalized title contains the other, so NO date is
  // attached (a wrong date is worse than none).
  assert.equal(lookupSnapshotRange('Playmobil 2026 Exhibition at the Military Historical Museum of València', map), null);
  assert.equal(lookupSnapshotRange('A totally unrelated evergreen guide', map), null);
});

test('buildVisitvalenciaEvents: snapshot ranges date the matching cards (real shapes)', () => {
  const rows = [
    {
      id: 1807,
      source_key: 'web:visitvalencia',
      title: 'Valencia Events | Events in Valencia | Upcoming Events',
      raw_text: SNAP_1807,
      raw_json: '{"kind":"page_snapshot","source_page":"https://www.visitvalencia.com/en/events-valencia"}',
      url: BASE,
    },
    card(741, "Anselm Kiefer's exhibition comes to Valencia", 'anselm-kiefers-exhibition-comes-valencia'),
    card(746, '«Music and Mathematics» Exhibition at CaixaForum in Valencia', 'music-and-mathematics-exhibition-caixaforum-valencia'),
    // a card the snapshot never dated stays honestly null
    card(778, '«Alegría - In A New Light» by Cirque du Soleil lands in Valencia', 'alegria-new-light-cirque-du-soleil-lands-valencia'),
  ];
  const out = buildVisitvalenciaEvents(rows, TODAY);
  assert.equal(out.length, 3);

  const kiefer = out.find((o) => o.sourceItemId === 741).draft;
  assert.equal(kiefer.start_date, '2026-04-28');
  assert.equal(kiefer.end_date, '2026-10-25');

  const caixa = out.find((o) => o.sourceItemId === 746).draft;
  assert.equal(caixa.start_date, '2025-12-11');
  assert.equal(caixa.end_date, '2026-08-23');

  const alegria = out.find((o) => o.sourceItemId === 778).draft;
  assert.equal(alegria.start_date, null);
  assert.equal(alegria.end_date, null);
});

// REGRESSION (live events 27450–27456, 2026-08-07 ingest): the glued trailing range
// must (1) clean the stored title, (2) beat parseEventDate — which misread
// "…you can see in August 27/07/2026 - 31/08/2026" as month-first "August 27" (that
// misparse is now pinned at the stripTrailingCardRange level: since T206 the August
// roundup ARTICLE itself never becomes an event at all).
test('buildVisitvalenciaEvents: glued card range → clean title + correct start/end', () => {
  const rows = [
    // verbatim source_items 2314 — the monthly roundup ARTICLE: even with its real
    // glued range it is a guide, not an event → dropped entirely (T206)
    card(2314, 'Exhibitions in València: everything you can see in August 27/07/2026 - 31/08/2026',
      'exhibitions-valencia-everything-you-can-see-august'),
    // verbatim source_items 2311
    card(2311, 'Summer Amusement Park in Valencia 2026 23/06/2026 - 08/08/2026',
      'valencia-summer-amusement-fair-returns'),
  ];
  const out = buildVisitvalenciaEvents(rows, new Date('2026-08-08T00:00:00Z'));
  assert.equal(out.length, 1);
  assert.equal(out.find((o) => o.sourceItemId === 2314), undefined);

  const funfair = out.find((o) => o.sourceItemId === 2311).draft;
  assert.equal(funfair.title, 'Summer Amusement Park in Valencia 2026');
  assert.equal(funfair.start_date, '2026-06-23');
  assert.equal(funfair.end_date, '2026-08-08');
  // the range is peeled from description/raw_excerpt too (raw_text == title live)
  assert.equal(funfair.description, 'Summer Amusement Park in Valencia 2026');
});

// ---------------------------------------------------------------------------
// T206 — guide/listicle articles are NOT events; full-year placeholders are not dates
// ---------------------------------------------------------------------------

test('isVisitvalenciaGuideCard: real live guide titles are classified as guides', () => {
  const guide = (title, slug) => isVisitvalenciaGuideCard(title, `${BASE}/${slug}`);
  // every pair below is a verbatim live source_items title+slug
  assert.equal(guide('Best places to enjoy flamenco in Valencia', 'best-places-enjoy-flamenco-valencia'), true);
  assert.equal(guide('The Best Spas in Valencia to Disconnect and Recharge', 'best-spas-valencia-disconnect-and-recharge'), true);
  assert.equal(guide('The Best Spas for a Relaxing Day in Valencia', 'best-spas-relaxing-day-valencia'), true);
  assert.equal(guide('Must-see immersive exhibitions this spring in Valencia', 'must-see-immersive-exhibitions-spring-valencia'), true);
  assert.equal(guide('Where to Watch the FIFA World Cup in Valencia', 'where-watch-fifa-world-cup-valencia'), true);
  assert.equal(guide('Where to have a late breakfast near the sea in València', 'where-have-late-breakfast-near-sea-valencia'), true);
  assert.equal(guide('Three ways to enjoy live jazz in Valencia', 'three-ways-enjoy-live-jazz-valencia'), true);
  assert.equal(guide('Exhibitions in València: everything you can see in August', 'exhibitions-valencia-everything-you-can-see-august'), true);
  // slug catch (live): the card was RETITLED "…2026 Calendar 2026" but its slug kept
  // the guide shape — the slug check still classifies it.
  assert.equal(guide('Valencia’s Circuit Ricardo Tormo 2026 Calendar 2026', 'must-see-racing-events-ricardo-tormo-circuit'), true);
  // the "…guide" title shape (no live row yet — T206 names it explicitly)
  assert.equal(guide('Valencia comedy guide', 'valencia-comedy-guide'), true);
});

test('isVisitvalenciaGuideCard: real event titles never match (mid-title "best" etc.)', () => {
  const guide = (title, slug) => isVisitvalenciaGuideCard(title, `${BASE}/${slug}`);
  // mid-title "best" belongs to real events/experiences — must be KEPT
  assert.equal(guide('The Champions Burger: Taste the best burgers in Valencia', 'champions-burger-valencia'), false);
  assert.equal(guide('Discover the San José Caves, the best-kept underground secret near Valencia', 'san-jose-caves-excursion-valencia'), false);
  assert.equal(guide('Enjoy the best live flamenco!', 'enjoy-best-live-flamenco'), false);
  // "guided tours" are real experiences — \bguides?\b must not match "guided"
  assert.equal(guide('Guided tours of San Juan del Hospital', 'guided-tours-san-juan-del-hospital'), false);
  assert.equal(guide('Guided tours to discover the secrets of the Palau de Les Arts', 'guided-tours-discover-secrets-palau-de-les-arts'), false);
  // a dated fair programme is an event, not a listicle
  assert.equal(guide('Stand-up comedy and comedy nights at the July Fair in Valencia', 'stand-comedy-and-comedy-nights-july-fair-valencia'), false);
  assert.equal(guide('Watch Valencia CF matches at Mestalla', 'watch-best-soccer-matches-live-mestalla-stadium'), false);
  assert.equal(isVisitvalenciaGuideCard('Rod Stewart concert in València', null), false);
});

test('isFullYearPlaceholder: same-year 01/01→31/12 only', () => {
  assert.equal(isFullYearPlaceholder('2026-01-01', '2026-12-31'), true);
  assert.equal(isFullYearPlaceholder('2027-01-01', '2027-12-31'), true);
  // cross-year and genuine ranges are NOT placeholders
  assert.equal(isFullYearPlaceholder('2026-01-01', '2027-12-31'), false);
  assert.equal(isFullYearPlaceholder('2025-10-30', '2026-10-29'), false);
  assert.equal(isFullYearPlaceholder('2026-06-25', '2026-12-31'), false);
  assert.equal(isFullYearPlaceholder('2026-01-01', '2026-06-30'), false);
});

test('stripTrailingCardRange: a glued full-year placeholder cleans the title, yields NO range', () => {
  const a = stripTrailingCardRange('Mestalla Forever Tour: Experience Valencia CF from the Inside 01/01/2026 - 31/12/2026');
  assert.equal(a.title, 'Mestalla Forever Tour: Experience Valencia CF from the Inside');
  assert.equal(a.range, null);
  // a garbage tail still leaves the title untouched (start implausible)
  const b = stripTrailingCardRange('Some event 45/13/2026 - 99/99/2026');
  assert.equal(b.title, 'Some event 45/13/2026 - 99/99/2026');
  assert.equal(b.range, null);
});

// Verbatim excerpt of live snapshot row 1807 (2026-07-05): the evergreen experiences
// carry the site's full-year placeholder "From 01/01/2026 to 31/12/2026" in BOTH the
// split and the inline markup; real ranges (incl. one that merely ENDS on 31/12) sit
// right next to them.
const SNAP_1807_PLACEHOLDER = `
 Discover Valencia’s Holy Grail in a unique exhibition at the Almudín

 From
 30/10/2025
 to 29/10/2026

 Discover Valencia’s Holy Grail in a unique exhibition at the Almudín

 exhibitions

 “The Light of San Nicolás”: an immersive experience in Valencia

 From
 01/01/2026
 to 31/12/2026

 “The Light of San Nicolás”: an immersive experience in Valencia

 Must-see immersive exhibitions this spring in Valencia

 From 25/06/2026 to 31/12/2026

 Three different tourist buses to explore Valencia

 From 01/01/2026 to 31/12/2026

 Three different tourist buses to explore Valencia

 Mestalla Forever Tour: Experience Valencia CF from the Inside

 From 01/01/2026 to 31/12/2026

 Mestalla Forever Tour: Experience Valencia CF from the Inside
`;

test('scanSnapshotDates: full-year placeholders record NO range; real neighbours survive', () => {
  const map = new Map();
  scanSnapshotDates(SNAP_1807_PLACEHOLDER, map);
  // placeholders (split AND inline forms) → no entry at all
  assert.equal(map.has('the light of san nicolas an immersive experience in valencia'), false);
  assert.equal(map.has('three different tourist buses to explore valencia'), false);
  assert.equal(map.has('mestalla forever tour experience valencia cf from the inside'), false);
  // a real cross-year range right above them is untouched
  assert.deepEqual(map.get('discover valencias holy grail in a unique exhibition at the almudin'),
    { start: '2025-10-30', end: '2026-10-29' });
  // a range that merely ENDS on 31/12 but starts mid-year is REAL — kept
  assert.deepEqual(map.get('must see immersive exhibitions this spring in valencia'),
    { start: '2026-06-25', end: '2026-12-31' });
});

test('buildVisitvalenciaEvents: placeholder-dated evergreens emit with honest null dates', () => {
  const rows = [
    {
      id: 1807,
      source_key: 'web:visitvalencia',
      title: 'Valencia Events | Events in Valencia | Upcoming Events',
      raw_text: SNAP_1807_PLACEHOLDER,
      raw_json: '{"kind":"page_snapshot","source_page":"https://www.visitvalencia.com/en/events-valencia"}',
      url: BASE,
    },
    // live evergreen cards whose only "date" is the full-year placeholder
    card(801, 'Mestalla Forever Tour: Experience Valencia CF from the Inside', 'mestalla-forever-tour-experience-valencia-cf-inside'),
    card(802, 'Three different tourist buses to explore Valencia', 'three-different-tourist-buses-explore-valencia'),
    // a real cross-year exhibition from the same snapshot keeps its published range
    card(803, 'Discover Valencia’s Holy Grail in a unique exhibition at the Almudín', 'discover-valencias-holy-grail-unique-exhibition-almudin'),
  ];
  const out = buildVisitvalenciaEvents(rows, TODAY);
  assert.equal(out.length, 3);

  const mestalla = out.find((o) => o.sourceItemId === 801).draft;
  assert.equal(mestalla.start_date, null); // NOT 2026-01-01 — the placeholder is not a date
  assert.equal(mestalla.end_date, null);

  const buses = out.find((o) => o.sourceItemId === 802).draft;
  assert.equal(buses.start_date, null);
  assert.equal(buses.end_date, null);

  const grail = out.find((o) => o.sourceItemId === 803).draft;
  assert.equal(grail.start_date, '2025-10-30');
  assert.equal(grail.end_date, '2026-10-29');
});

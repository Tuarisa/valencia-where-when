import test from 'node:test';
import assert from 'node:assert/strict';

// T-FR001 — russpain.com (web:russpain) event normalizer. Imports the ACTUAL pure
// functions from the normalizer (DB-free: buildRusspainEvents skips the page_snapshot
// and never touches the DB). Fixtures are FAITHFUL to the real live shape observed in
// the local DB: the generic web parser emits a `page_snapshot` of the listing page
// plus chrome/nav `link_card` rows ("Continue to RUSSPAIN.COM", "Publishing
// Principles", "Corrections Policy"); since the 2026-08 site reorganisation the
// `/afisha/valencia/` URL serves the ENGLISH NEWS homepage, so the crawl yields
// `/news/<article>/` + `/cat/<category>/` link_cards (live ids 2182-2212) which are
// NEWS, not events, and MUST all be dropped (T154 — the old fall-through emitted 30
// bogus "events" from them). Once the afisha is restored, per-listing
// `/afisha/valencia/<slug>` cards carrying a DATED RU/ES body are emitted. Asserts:
// junk/news dropped, dated real listing kept, undated dropped (T140: never fabricate),
// source key == sources.json.

import {
  RUSSPAIN_SOURCE_KEY,
  buildRusspainEvents,
} from '../lib/pipeline/normalizers/russpain.ts';

// Helper: a raw source_items row shape (loose, like the live rows).
const card = (
  id,
  title,
  raw_text = title,
  raw_json = '{"kind":"link_card","source_page":"https://russpain.com/afisha/valencia/"}',
  url = `https://russpain.com/afisha/valencia/${id}`,
) => ({
  id,
  source_key: 'web:russpain',
  title,
  raw_text,
  raw_json,
  url,
});

test('source key matches sources.json (id 25)', () => {
  assert.equal(RUSSPAIN_SOURCE_KEY, 'web:russpain');
});

test('REAL shape: the 404 page_snapshot row is dropped (even with an embedded date)', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  // Faithful to live row id 588: the "Page Not Found" reorganisation splash. The body
  // is the site's nav chrome + the language-edition notice + an "updated June 18, 2026"
  // timestamp. That embedded date MUST NOT leak an event — the page_snapshot guard
  // (raw.kind === 'page_snapshot') drops the whole row before any date parsing.
  const rows = [
    {
      id: 588,
      source_key: 'web:russpain',
      title: 'Page Not Found',
      raw_text:
        'Page Not Found / Страница не найдена / Página no encontrada\n' +
        'RUSSPAIN has been reorganised into separate language editions - RU - EN - ES.\n' +
        'Русскоязычная версия сайта переехала на отдельный домен RUSSPAIN.RU.\n' +
        'Continue to RUSSPAIN.COM / Ir a ESPAÑOL.NEWS\n' +
        'updated June 18, 2026, 9:29 AM\n' +
        '© 1998 - 2026 RUSSPAIN English Spain News All Rights Reserved',
      raw_json:
        '{"kind":"page_snapshot","meta":{"title":"Page Not Found","og:image":"https://russpain.com/uploads/media/9/2026/06/16/x.png"}}',
      url: 'https://russpain.com/afisha/valencia/',
    },
  ];
  assert.equal(buildRusspainEvents(rows, today).length, 0);
});

test('REAL shape: chrome/nav link_card rows are dropped (live ids 589-591)', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const rows = [
    // id 589: cross-edition redirect homepage (bare russpain.com/) — dropped by URL.
    {
      id: 589,
      source_key: 'web:russpain',
      title: 'Continue to RUSSPAIN.COM',
      raw_text: 'Continue to RUSSPAIN.COM',
      raw_json: '{"kind":"link_card","source_page":"https://russpain.com/afisha/valencia/"}',
      url: 'https://russpain.com/',
    },
    // id 590: legal/chrome page.
    {
      id: 590,
      source_key: 'web:russpain',
      title: 'Publishing Principles',
      raw_text: 'Publishing Principles',
      raw_json: '{"kind":"link_card","source_page":"https://russpain.com/afisha/valencia/"}',
      url: 'https://russpain.com/publishing-principles/',
    },
    // id 591: legal/chrome page.
    {
      id: 591,
      source_key: 'web:russpain',
      title: 'Corrections Policy',
      raw_text: 'Corrections Policy',
      raw_json: '{"kind":"link_card","source_page":"https://russpain.com/afisha/valencia/"}',
      url: 'https://russpain.com/corrections-policy/',
    },
  ];
  assert.equal(buildRusspainEvents(rows, today).length, 0, 'all chrome rows dropped');
});

test('cross-domain language-edition redirects are dropped (russpain.ru / español.news)', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const rows = [
    card(700, 'Перейти на RUSSPAIN.RU', 'Перейти на RUSSPAIN.RU', undefined, 'https://russpain.ru/'),
    card(701, 'Ir a ESPAÑOL.NEWS', 'Ir a ESPAÑOL.NEWS', undefined, 'https://español.news/'),
  ];
  assert.equal(buildRusspainEvents(rows, today).length, 0);
});

test('the afisha INDEX page itself (no listing slug) is dropped', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const rows = [
    card(
      800,
      'Афиша Валенсии',
      'Афиша Валенсии 2026',
      '{"kind":"link_card"}',
      'https://russpain.com/afisha/valencia/',
    ),
  ];
  assert.equal(buildRusspainEvents(rows, today).length, 0);
});

test('a REAL dated /afisha/valencia listing is KEPT with date + venue + price parsed', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const rows = [
    card(
      900,
      'Концерт русской музыки в Валенсии',
      'Концерт русской музыки 23 июля 2026 в Palau de la Música, вход 15 eur',
      '{"kind":"link_card","meta":{"og:image":"https://russpain.com/uploads/x.jpg"}}',
      'https://russpain.com/afisha/valencia/koncert-russkoy-muzyki/',
    ),
  ];
  const out = buildRusspainEvents(rows, today);
  assert.equal(out.length, 1, 'the real listing survives');
  const d = out[0].draft;
  assert.equal(out[0].sourceItemId, 900);
  assert.equal(d.title, 'Концерт русской музыки в Валенсии');
  assert.equal(d.start_date, '2026-07-23', 'free-text RU date parsed');
  assert.equal(d.price, '15 €');
  assert.equal(d.is_free, 0);
  assert.equal(d.city, 'Valencia');
  assert.equal(d.country, 'Spain');
  assert.equal(d.source, 'web:russpain');
  assert.equal(d.image_url, 'https://russpain.com/uploads/x.jpg');
  // venue cue "Palau de la Música" should be picked up.
  assert.ok(d.venue_name && d.venue_name.includes('Palau'), 'venue parsed');
});

test('prefers a date encoded in the URL slug over body text', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const rows = [
    card(
      901,
      'Выставка в Валенсии',
      'Выставка открывается скоро',
      '{"kind":"link_card"}',
      'https://russpain.com/afisha/valencia/vystavka-2026-08-15/',
    ),
  ];
  const out = buildRusspainEvents(rows, today);
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, '2026-08-15', 'URL-slug date wins');
});

test('an UNDATED listing is DROPPED — T140: no date → do not emit, never fabricate', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const rows = [
    card(
      902,
      'Русский разговорный клуб в Валенсии',
      'Русский разговорный клуб, приходите познакомиться',
      '{"kind":"link_card"}',
      'https://russpain.com/afisha/valencia/russkiy-klub/',
    ),
  ];
  assert.equal(buildRusspainEvents(rows, today).length, 0, 'undated card yields no event');
});

// REAL rows from the live DB (ids 2182-2212, ingested 2026-08-07): after the site
// reorganisation `/afisha/valencia/` serves the English news homepage, and the crawl
// yields `/news/…` + `/cat/…` link_cards. These are NEWS HEADLINES — some carry a
// parseable date ("Solar Eclipse on August 12") or a money amount ("Messi Donates
// €80,000" — the pre-T154 code emitted it as an event priced "80 €") — and ALL must
// be dropped by the default-deny URL guard before any date/price parsing.
test('REAL 2026-08 shape: /news/ + /cat/ link_cards are ALL dropped (live ids 2183-2212)', () => {
  const today = new Date('2026-08-08T00:00:00Z');
  const linkJson = '{"kind":"link_card","source_page":"https://russpain.com/afisha/valencia/"}';
  const rows = [
    // id 2183 — news article, Valencia-adjacent wording but NOT an event.
    { id: 2183, source_key: 'web:russpain', title: 'Red Flags Close Badalona, Montgat and Sant Adrià Beaches After Rain', raw_text: 'Red Flags Close Badalona, Montgat and Sant Adrià Beaches After Rain', raw_json: linkJson, url: 'https://russpain.com/news/red-flags-close-badalona-montgat-and-sant-adria-beaches-after-rain-79211/' },
    // id 2184 — DATE TRAP: "August 12" parses, but a /news/ article is not an event.
    { id: 2184, source_key: 'web:russpain', title: 'Solar Eclipse on August 12: Totality Zone to Cross 40% of Spain', raw_text: 'Solar Eclipse on August 12: Totality Zone to Cross 40% of Spain', raw_json: linkJson, url: 'https://russpain.com/news/solar-eclipse-on-august-12-totality-zone-to-cross-40-of-spain-79191/' },
    // id 2188 — PRICE TRAP: "€80,000" parsed as price "80 €" pre-T154.
    { id: 2188, source_key: 'web:russpain', title: 'Messi Donates €80,000 for Sierra Oeste Recovery After Madrid Wildfire', raw_text: 'Messi Donates €80,000 for Sierra Oeste Recovery After Madrid Wildfire', raw_json: linkJson, url: 'https://russpain.com/news/messi-donates-eur80-000-for-sierra-oeste-recovery-after-madrid-wildfire-78217/' },
    // id 2201 — category hub page.
    { id: 2201, source_key: 'web:russpain', title: 'Statistics and Rankings', raw_text: 'Statistics and Rankings', raw_json: linkJson, url: 'https://russpain.com/cat/statistics-and-rankings/' },
    // id 2202 — FREE TRAP: "Tax-Free" matched the free-admission cue pre-T154.
    { id: 2202, source_key: 'web:russpain', title: 'Spanish Notary Clarifies: Giving Money to Children Is Tax-Neutral, But Not Tax-Free', raw_text: 'Spanish Notary Clarifies: Giving Money to Children Is Tax-Neutral, But Not Tax-Free', raw_json: linkJson, url: 'https://russpain.com/news/spanish-notary-clarifies-giving-money-to-children-is-tax-neutral-but-not-tax-free-79273/' },
  ];
  assert.equal(buildRusspainEvents(rows, today).length, 0, 'every news/cat card dropped');
});

test('REAL 2026-08 shape: the news-homepage page_snapshot at /afisha/valencia/ is dropped (live id 2182)', () => {
  const today = new Date('2026-08-08T00:00:00Z');
  const rows = [
    {
      id: 2182,
      source_key: 'web:russpain',
      title: 'RUSSPAIN.COM Spain News in English — spanish news',
      raw_text:
        'RUSSPAIN.COM Spain News in English — spanish news \n\n About \n\n Last news \n \n Culture \n \n Celebrities \n \n Politics \n \n Weather & Nature \n \n Events \n \n Interesting \n \n Madrid \n\n Catalonia \n \n Valencia \n\n Andalusia \n\n Regions',
      raw_json:
        '{"kind":"page_snapshot","meta":{"title":"RUSSPAIN.COM Spain News in English — spanish news","og:image":"https://russpain.com/uploads/media/9/2026/07/09/20260709-6a4f6e7638ac96.01664552.png"}}',
      url: 'https://russpain.com/afisha/valencia/',
    },
  ];
  assert.equal(buildRusspainEvents(rows, today).length, 0);
});

test('free admission listing → price Free / is_free 1', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const rows = [
    card(
      903,
      'Бесплатный концерт в парке',
      'Бесплатный концерт 5 августа 2026, вход свободный',
      '{"kind":"link_card"}',
      'https://russpain.com/afisha/valencia/besplatnyy-koncert/',
    ),
  ];
  const out = buildRusspainEvents(rows, today);
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, '2026-08-05');
  assert.equal(out[0].draft.price, 'Free');
  assert.equal(out[0].draft.is_free, 1);
});

test('empty-title row is dropped (no crash)', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const rows = [card(904, '', '', '{"kind":"link_card"}', 'https://russpain.com/afisha/valencia/x/')];
  assert.equal(buildRusspainEvents(rows, today).length, 0);
});

test('mixed batch: only the real listings survive', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const rows = [
    {
      id: 1,
      source_key: 'web:russpain',
      title: 'Page Not Found',
      raw_text: 'Page Not Found',
      raw_json: '{"kind":"page_snapshot"}',
      url: 'https://russpain.com/afisha/valencia/',
    },
    card(2, 'Publishing Principles', 'Publishing Principles', '{"kind":"link_card"}', 'https://russpain.com/publishing-principles/'),
    card(
      3,
      'Литературный вечер в Валенсии',
      'Литературный вечер 12 сентября 2026, Biblioteca Central',
      '{"kind":"link_card"}',
      'https://russpain.com/afisha/valencia/literaturnyy-vecher/',
    ),
    card(4, 'Continue to RUSSPAIN.COM', 'Continue to RUSSPAIN.COM', '{"kind":"link_card"}', 'https://russpain.com/'),
  ];
  const out = buildRusspainEvents(rows, today);
  assert.deepEqual(out.map((o) => o.sourceItemId), [3], 'only the real listing survives');
  assert.equal(out[0].draft.start_date, '2026-09-12');
});

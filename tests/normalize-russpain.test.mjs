import test from 'node:test';
import assert from 'node:assert/strict';

// T-FR001 — russpain.com (web:russpain) event normalizer. Imports the ACTUAL pure
// functions from the normalizer (DB-free: buildRusspainEvents skips the page_snapshot
// and never touches the DB). Fixtures are FAITHFUL to the real live shape observed in
// the local DB: the generic web parser emits a `page_snapshot` of the listing page
// plus chrome/nav `link_card` rows ("Continue to RUSSPAIN.COM", "Publishing
// Principles", "Corrections Policy"), and — once the afisha is restored — per-listing
// `/afisha/valencia/<slug>` cards carrying a dated/priced RU/ES body. Asserts: junk
// dropped, real listing kept, date parsed, source key == sources.json.

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

test('REAL shape: the 404 page_snapshot row is dropped', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  // Faithful to live row id 588: a Page Not Found snapshot.
  const rows = [
    {
      id: 588,
      source_key: 'web:russpain',
      title: 'Page Not Found',
      raw_text: 'Page Not Found / Страница не найдена / Página no encontrada …',
      raw_json:
        '{"kind":"page_snapshot","meta":{"title":"Page Not Found","og:image":"https://russpain.com/uploads/media/x.png"}}',
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

test('an undated real listing still renders (start_date null, not dropped)', () => {
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
  const out = buildRusspainEvents(rows, today);
  assert.equal(out.length, 1, 'undated listing is kept');
  assert.equal(out[0].draft.start_date, null);
  assert.equal(out[0].draft.title, 'Русский разговорный клуб в Валенсии');
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

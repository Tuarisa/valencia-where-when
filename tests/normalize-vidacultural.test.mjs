import test from 'node:test';
import assert from 'node:assert/strict';

// T146 — vidacultural (Telegram) non-event guard. Imports the ACTUAL pure functions
// from the normalizer (DB-free). Asserts channel-header / "pinned a photo" / bare-@handle
// meta posts are DROPPED while real family-event posts (with a date / venue) are KEPT.

import {
  buildVidaculturalEvents,
  looksLikeEvent,
  postTitle,
  stripPromoIntro,
} from '../lib/pipeline/normalizers/vidacultural.ts';
import { isJunkCard } from '../lib/pipeline/normalizers/valenciarusa.ts';

const VC = 'Культурне життя Валенсії/Vida Cultural de Valencia';

// `opts` lets a T209 fixture carry the live row's published_at/first_seen/last_seen
// (the post-date anchor); absent → postDateOf is null and the `today` param anchors.
const post = (id, raw_text, media = [], opts = {}) => ({
  id,
  source_key: 'tg:vidacultural_Valencia',
  title: (raw_text || '').split('\n')[0] || null,
  raw_text,
  raw_json: JSON.stringify({ kind: 'telegram_post', post_ref: `vidacultural_Valencia/${id}`, media_urls: media }),
  url: `https://t.me/vidacultural_Valencia/${id}`,
  published_at: opts.published_at ?? null,
  first_seen: opts.first_seen ?? undefined,
  last_seen: opts.last_seen ?? undefined,
});

test('T146 isJunkCard: bare channel-header post is JUNK', () => {
  assert.equal(isJunkCard(VC, VC, VC), true);
});

test('T146 isJunkCard: "<channel> pinned a photo" is JUNK', () => {
  assert.equal(isJunkCard(`${VC} pinned a photo`, `${VC} pinned a photo`, VC), true);
  assert.equal(isJunkCard('Someone pinned a message', 'Someone pinned a message', VC), true);
});

test('T146 isJunkCard: "<channel> 499 views 15:28" meta header is JUNK', () => {
  assert.equal(isJunkCard(`${VC} 499 views 15:28`, `${VC} 499 views 15:28`, VC), true);
});

test('T146 isJunkCard: bare @handle is JUNK', () => {
  assert.equal(isJunkCard('@janeS_31', '@janeS_31', VC), true);
});

test('T146 isJunkCard: a real family-event post is KEPT (not junk)', () => {
  const real = '🎷 ALBORAJAZZ 2026: фінальний концерт 📅 14 червня 🕗 20:00 📍 Plaza de la Constitución, Альборая 🎟 Вхід вільний';
  assert.equal(isJunkCard(real.split('\n')[0], real, VC), false);
});

test('T146 build: drops channel/header/handle meta, keeps real dated events', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const real1 = '🎷 ALBORAJAZZ 2026: фінальний концерт 📅 14 червня (неділя) 🕗 20:00 📍 Plaza de la Constitución, Альборая 🎟 Вхід вільний';
  const real2 = '🎼 SERENATES 2026 📍 Centre Cultural La Nau, Carrer de la Universitat, 2, València 📅 20 червня – 2 липня 2026';
  const rows = [
    post(41, VC),                       // bare channel header
    post(48, '@janeS_31'),              // bare handle
    post(51, `${VC} pinned a photo`),   // pinned meta
    post(53, `${VC} 499 views 15:28`),  // channel + views meta
    post(49, real1),                    // REAL event (date + venue)
    post(54, real2),                    // REAL event (date + venue)
  ];
  const out = buildVidaculturalEvents(rows, today);
  const keptIds = out.map((o) => o.sourceItemId).sort((a, b) => a - b);
  assert.deepEqual(keptIds, [49, 54], 'only the two real events survive');
});

test('looksLikeEvent: existing behaviour stays green', () => {
  assert.equal(looksLikeEvent('🎷 концерт 📍 Plaza de la Constitución', false), true);
  assert.equal(looksLikeEvent('коротко', false), false);
  assert.equal(looksLikeEvent('подія', true), false); // too short even with a date
});

test('postTitle: existing behaviour stays green', () => {
  // single-line headline with a leading date prefix → prefix stripped
  assert.equal(postTitle('21 червня — Concierto en La Nau'), 'Concierto en La Nau');
  assert.equal(postTitle(null, 'Fallback'), 'Fallback');
});

// T196 — promo-intro noise. A post that opens with a city tag + flag + generic ad copy
// ("У нас для Вас просто космічні новини 🪐") before the real event must NOT keep the
// ad copy as its title; the substantive remainder is used instead.
test('T196 stripPromoIntro: peels a leading "У нас для Вас … 🪐" ad clause', () => {
  const promo = 'Валенсія 🚩 У нас для Вас просто космічні новини 🪐 26 червня у Валенсії відбудеться спецпоказ фільму «ТИ - КОСМОС». Це українська кіноперлина';
  const stripped = stripPromoIntro(promo);
  assert.ok(!/У нас для Вас/i.test(stripped), 'promo ad copy removed');
  assert.match(stripped, /спецпоказ фільму «ТИ - КОСМОС»/, 'real event content kept');
});

test('T196 stripPromoIntro: a non-promo post is returned unchanged', () => {
  const real = 'ФРІДА КАЛО У ВАЛЕНСІЇ: ЖІНКА, ЯКА ПЕРЕТВОРИЛА БІЛЬ У МИСТЕЦТВО У Валенсії триває імерсивна виставка';
  assert.equal(stripPromoIntro(real), real);
  const fest = 'SERENATES 2026 | Один із найатмосферніших фестивалів літа у Валенсії';
  assert.equal(stripPromoIntro(fest), fest);
});

test('T196 postTitle: a promo-prefixed post yields a clean (non-promo) title', () => {
  const promo = 'Валенсія 🚩 У нас для Вас просто космічні новини 🪐 26 червня у Валенсії відбудеться спецпоказ фільму «ТИ - КОСМОС».';
  const title = postTitle(promo);
  assert.ok(!/У нас для Вас/i.test(title), 'title no longer leads with promo ad copy');
  assert.match(title, /спецпоказ фільму «ТИ - КОСМОС»/);
});

// ---------------------------------------------------------------------------
// T209 (T207 sibling) — year inference is anchored to the POST date, not to
// normalize time. Fixtures are VERBATIM raw_text/timestamps from the live DB rows
// that produced the fabricated 2027 dates (source_items 1057 → twins 26522/26578,
// 1054 → orphan roll 26516).
// ---------------------------------------------------------------------------

// Live row 1057 (published 2026-06-24): «26 червня … спецпоказ фільму „ТИ - КОСМОС"»
// was re-offered (telegram embed re-shows old posts → last_seen bumped to 2026-07-05)
// and re-normalized AFTER June 26 had passed → rolled to 2027-06-26, inserting twin
// 26578 next to the correct 26522 under a new dedup_hash.
const KOSMOS_BODY = 'Валенсія 🚩 У нас для Вас просто космічні новини 🪐 26 червня у Валенсії відбудеться спецпоказ фільму «ТИ - КОСМОС». Це українська кіноперлина, яка ще до прем’єри здобула 13 міжнародних нагород та 9 номінацій. Це той фільм, який варто дивитись саме на великому екрані кінотеатру 🪐 У центрі історії - український космічний далекобійник Андрій, який після вибуху Землі залишається єдиною людиною у Всесвіті. Його єдиний контакт із життям - загадкова француженка Катрін, заради якої він вирушає у небезпечну подорож крізь космос. 📍 ВАЛЕНСІЯ 📆 26 ЧЕРВНЯ | ПʼЯТНИЦЯ | 19:30 🎥 Кінотеатр: Cines MN4 (Centro Comercial y de Ocio MN4) 🎟️ Квитки: https://billetto.es/en/e/-entradas-1956684 Не пропустіть цю подорож у космос! 🚀 ~ Культурне життя Валенсії ~';
const KOSMOS_OPTS = {
  published_at: '2026-06-24T10:53:14+00:00',
  first_seen: '2026-06-24T21:31:02Z',
  last_seen: '2026-07-05T03:03:37Z',
};

test('T209: year anchors to the POST date — «26 червня» published 2026-06-24 stays 2026 when re-normalized after the date passed', () => {
  const rows = [post(1057, KOSMOS_BODY, [], KOSMOS_OPTS)];
  // 2026-07-05T03:07 = the live re-normalize moment that fabricated twin 26578.
  const out = buildVidaculturalEvents(rows, new Date('2026-07-05T03:07:02Z'));
  assert.equal(out.length, 1, 'dated event should be kept');
  assert.equal(out[0].draft.start_date, '2026-06-26', 'post-date anchor, no roll to 2027');
});

test('T209: stable across normalize times — same post, before vs after the event date, same draft', () => {
  const rows = [post(1057, KOSMOS_BODY, [], KOSMOS_OPTS)];
  const before = buildVidaculturalEvents(rows, new Date('2026-06-24T21:33:00Z'));
  const after = buildVidaculturalEvents(rows, new Date('2026-07-05T03:07:02Z'));
  assert.deepEqual(before, after, 'normalize time must not change the draft (hash stability)');
  assert.equal(before[0].draft.start_date, '2026-06-26');
});

// Live row 1054 (published 2026-06-22): the San Juan post «вже завтра, 23 червня» was
// re-normalized on 2026-07-05 and rolled to 2027-06-23 (orphan 26516). With the post
// anchor «23 червня» resolves against 2026-06-22 → 2026-06-23, at any normalize time.
test('T209: «вже завтра, 23 червня» published 2026-06-22 resolves to 2026-06-23 even re-normalized weeks later', () => {
  const body = '🔥 Святкування San Juan у колі українців у Валенсії — вже завтра, 23 червня! Чекаємо всіх на пляжі з 17:00 💃 🔥 🕺🏻 📍 Локація зустрічі: https://maps.app.goo.gl/Uow3bEJArqtrtNGJ9?g_st=iw 💙 ОРІЄНТИР — український прапор 🇺🇦 ❓ Що на вас чекає: 🤝 Весела атмосфера у дружньому колі українців 🇺🇦 🏐 Пляжний волейбол 🎸 Музика, танці та гітара 🔥 Стрибки через вогнище 🌊 Нічне купання у морі 🌙 🎉 Свято до самого ранку Не пропустіть найяскравішу подію літа ! 🔥 ~ Культурне життя Валенсії ~';
  const rows = [post(1054, body, [], {
    published_at: '2026-06-22T09:04:15+00:00',
    first_seen: '2026-06-24T21:31:02Z',
    last_seen: '2026-07-05T03:03:37Z',
  })];
  const out = buildVidaculturalEvents(rows, new Date('2026-07-05T03:07:02Z'));
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, '2026-06-23', 'the post-time tomorrow, not next year');
});

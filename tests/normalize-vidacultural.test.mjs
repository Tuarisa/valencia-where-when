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

const post = (id, raw_text, media = []) => ({
  id,
  source_key: 'tg:vidacultural_Valencia',
  title: (raw_text || '').split('\n')[0] || null,
  raw_text,
  raw_json: JSON.stringify({ kind: 'telegram_post', post_ref: `vidacultural_Valencia/${id}`, media_urls: media }),
  url: `https://t.me/vidacultural_Valencia/${id}`,
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

import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of lib/pipeline/normalizers/spain-filter.ts (T131).
const SPAIN = ['valencia', 'valència', 'валенси', 'madrid', 'мадрид', 'barcelona', 'барселон', 'sevilla', 'севиль', 'malaga', 'málaga', 'малаг', 'bilbao', 'бильбао', 'zaragoza', 'сарагос', 'alicante', 'alacant', 'аликанте', 'murcia', 'мурси', 'granada', 'гранад', 'gandia', 'gandía', 'гандия', 'castellon', 'castellón', 'кастельон', 'torrevieja', 'торревьех', 'marbella', 'марбель', 'palma', 'пальма', 'mallorca', 'майорк', 'tenerife', 'тенериф', 'canaria', 'канар', 'canarias', 'españa', 'espana', 'spain', 'испани',
  // Latin-translit Spanish-city stems (T153) — worldafisha URL slugs + RU posts.
  'valensi', 'barselon', 'alikante', 'marbel', 'sevil', 'saragos', 'tenerif'];
const NON_SPAIN = ['berlin', 'берлин', 'paris', 'париж', 'london', 'лондон', 'lisboa', 'лиссабон'];
const has = (t, list) => list.some((k) => t.includes(k));
const isSpainEvent = (text) => has((text || '').toLowerCase(), SPAIN);
const hasNonSpainSignal = (text) => has((text || '').toLowerCase(), NON_SPAIN);

test('isSpainEvent: keeps explicit Spain (ES + RU spellings)', () => {
  assert.equal(isSpainEvent('Слава Комиссаренко — Валенсия, 10 июля'), true);
  assert.equal(isSpainEvent('Concierto en Madrid'), true);
  assert.equal(isSpainEvent('Tour: Barcelona, Sevilla, Málaga'), true);
  assert.equal(isSpainEvent('Гастроли по Испании'), true);
});

test('isSpainEvent: recognises Latin-translit Spanish cities (worldafisha slugs, T153)', () => {
  assert.equal(isSpainEvent('https://worldafisha.com/event/aleksandr-gudkov-valensiya-2026-11-09'), true, 'valensiya → Valencia');
  assert.equal(isSpainEvent('https://worldafisha.com/event/little-big-barselona-2026-11-06'), true, 'barselona → Barcelona');
  assert.equal(isSpainEvent('https://worldafisha.com/event/bi-2-alikante-2026-11-21'), true, 'alikante → Alicante');
  assert.equal(isSpainEvent('https://worldafisha.com/event/ivan-urgant-marbelya-2026-07-18'), true, 'marbelya → Marbella');
  assert.equal(isSpainEvent('Тур: sevilya, saragosa'), true, 'sevilya → Sevilla, saragosa → Zaragoza');
});

test('isSpainEvent: drops non-Spain and location-less', () => {
  // Latin-translit non-Spain hubs must still be excluded after the T153 additions.
  assert.equal(isSpainEvent('https://worldafisha.com/event/morgenshtern-berlin-2026-10-22'), false, 'berlin slug stays non-Spain');
  assert.equal(isSpainEvent('Concert in Paris'), false, 'paris stays non-Spain');
  assert.equal(isSpainEvent('Тур: Берлин, Париж, Лондон'), false);
  assert.equal(isSpainEvent('Concert in Lisboa'), false);
  assert.equal(isSpainEvent('Новый альбом уже вышел'), false, 'no location → dropped (avoid overload)');
  assert.equal(isSpainEvent(''), false);
  assert.equal(isSpainEvent(null), false);
});

test('hasNonSpainSignal flags clearly-non-Spain hubs', () => {
  assert.equal(hasNonSpainSignal('Берлин, 5 мая'), true);
  assert.equal(hasNonSpainSignal('Валенсия'), false);
});

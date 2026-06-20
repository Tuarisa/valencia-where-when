import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of lib/pipeline/normalizers/spain-filter.ts (T131).
const SPAIN = ['valencia', 'valència', 'валенси', 'madrid', 'мадрид', 'barcelona', 'барселон', 'sevilla', 'севиль', 'malaga', 'málaga', 'малаг', 'bilbao', 'бильбао', 'zaragoza', 'сарагос', 'alicante', 'alacant', 'аликанте', 'murcia', 'мурси', 'granada', 'гранад', 'gandia', 'gandía', 'гандия', 'castellon', 'castellón', 'кастельон', 'torrevieja', 'торревьех', 'marbella', 'марбель', 'palma', 'пальма', 'mallorca', 'майорк', 'tenerife', 'тенериф', 'canaria', 'канар', 'canarias', 'españa', 'espana', 'spain', 'испани'];
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

test('isSpainEvent: drops non-Spain and location-less', () => {
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

import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of lib/pipeline/normalizers/worldafisha.ts (T110). DB-free: it
// re-implements the Spain keep/drop gate (from buildWorldafishaEvents) and the
// RU/ES/EN date parser (parseEventDate) exactly as the TS does, then asserts the
// invariants. Mirrors the spain-filter.test.mjs convention so the suite stays
// connection-free.

// --- mirror of spain-filter.ts ---
const SPAIN = ['valencia', 'valència', 'валенси', 'madrid', 'мадрид', 'barcelona', 'барселон', 'sevilla', 'севиль', 'malaga', 'málaga', 'малаг', 'bilbao', 'бильбао', 'zaragoza', 'сарагос', 'alicante', 'alacant', 'аликанте', 'murcia', 'мурси', 'granada', 'гранад', 'gandia', 'gandía', 'гандия', 'castellon', 'castellón', 'кастельон', 'torrevieja', 'торревьех', 'marbella', 'марбель', 'palma', 'пальма', 'mallorca', 'майорк', 'tenerife', 'тенериф', 'canaria', 'канар', 'canarias', 'españa', 'espana', 'spain', 'испани'];
const NON_SPAIN = ['berlin', 'берлин', 'paris', 'париж', 'london', 'лондон', 'lisboa', 'lisbon', 'лиссабон', 'amsterdam', 'амстердам'];
const has = (t, list) => list.some((k) => t.includes(k));
const isSpainEvent = (text) => has((text || '').toLowerCase(), SPAIN);
const hasNonSpainSignal = (text) => has((text || '').toLowerCase(), NON_SPAIN);

// --- mirror of the Spain keep/drop gate from buildWorldafishaEvents ---
// keep an item only when (a) it has a Spain signal somewhere, AND (b) it is NOT the
// ambiguous case "non-Spain hub present but Spain signal only in the body, not title".
function keepItem({ title, body = '', url = '' }) {
  const haystack = `${title} ${body} ${url}`;
  if (!isSpainEvent(haystack)) return false;
  if (hasNonSpainSignal(haystack) && !isSpainEvent(title)) return false;
  return true;
}

test('worldafisha Spain gate: keeps explicit-Spain tours', () => {
  assert.equal(keepItem({ title: 'Слава Комиссаренко — Валенсия, 10 июля' }), true);
  assert.equal(keepItem({ title: 'Concierto en Madrid' }), true);
  assert.equal(keepItem({ title: 'Баста — тур по Испании' }), true);
  // Spain hub in the title even alongside other cities → kept
  assert.equal(keepItem({ title: 'Tour: Barcelona · Berlin', body: '' }), true);
});

test('worldafisha Spain gate: drops non-Spain and location-less', () => {
  assert.equal(keepItem({ title: 'Тур: Берлин, Париж, Лондон' }), false);
  assert.equal(keepItem({ title: 'Concert in Lisboa' }), false);
  assert.equal(keepItem({ title: 'Новый альбом уже вышел' }), false);
  // ambiguous: Spain signal only in body AND a non-Spain hub present → dropped
  assert.equal(
    keepItem({ title: 'Большой тур', body: 'Берлин, Амстердам, Валенсия' }),
    false,
    'non-Spain hub + Spain signal only in body → too ambiguous, dropped',
  );
});

// --- mirror of parseEventDate ---
const MONTHS = [
  [/янв|enero|january|jan/i, 1], [/февр|febrero|february|feb/i, 2],
  [/март|марта|marzo|march|mar/i, 3], [/апрел|abril|april|apr/i, 4],
  [/ма[йя]|mayo|may/i, 5], [/июн|junio|june|jun/i, 6],
  [/июл|julio|july|jul/i, 7], [/авг|agosto|august|aug/i, 8],
  [/сент|septiembre|september|sep/i, 9], [/октяб|octubre|october|oct/i, 10],
  [/нояб|noviembre|november|nov/i, 11], [/декаб|diciembre|december|dec/i, 12],
];
const pad = (n) => String(n).padStart(2, '0');
function parseEventDate(text, today = new Date()) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const num = /\b(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?\b/.exec(t);
  if (num) {
    const day = Number(num[1]);
    const month = Number(num[2]);
    let year = num[3] ? Number(num[3]) : today.getFullYear();
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      if (!num[3] && month < today.getMonth() + 1) year += 1;
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }
  const named = /\b(\d{1,2})\s+(?:de\s+)?([A-Za-zА-Яа-яёЁ]{3,})\.?(?:\s+(?:de\s+)?(\d{4}))?/u.exec(t);
  if (named) {
    const day = Number(named[1]);
    let month = 0;
    for (const [re, m] of MONTHS) { if (re.test(named[2])) { month = m; break; } }
    if (month && day >= 1 && day <= 31) {
      let year = named[3] ? Number(named[3]) : today.getFullYear();
      if (!named[3] && month < today.getMonth() + 1) year += 1;
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }
  return null;
}

test('parseEventDate: ISO, numeric and named RU/ES dates', () => {
  const today = new Date('2026-06-20T00:00:00Z');
  assert.equal(parseEventDate('2026-07-10', today), '2026-07-10');
  assert.equal(parseEventDate('21.06.2026', today), '2026-06-21');
  assert.equal(parseEventDate('10/07/26', today), '2026-07-10');
  assert.equal(parseEventDate('21 июня 2026', today), '2026-06-21');
  assert.equal(parseEventDate('21 de junio de 2026', today), '2026-06-21');
  assert.equal(parseEventDate('10 julio', today), '2026-07-10');
});

test('parseEventDate: rolls a year-less past month to next year', () => {
  const today = new Date('2026-06-20T00:00:00Z');
  // May already passed in 2026 → next year
  assert.equal(parseEventDate('5 мая', today), '2027-05-05');
});

test('parseEventDate: null when no date present', () => {
  assert.equal(parseEventDate('Концерт в Валенсии', new Date('2026-06-20')), null);
  assert.equal(parseEventDate('', new Date()), null);
  assert.equal(parseEventDate(null, new Date()), null);
});

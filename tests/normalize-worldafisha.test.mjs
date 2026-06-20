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

// --- mirror of parseEventDate (kept byte-for-byte in sync with worldafisha.ts) ---
const MONTHS = [
  [/янв|січ|enero|january|jan/i, 1],
  [/фев|лют|febrero|february|feb/i, 2],
  [/март|мар(?![тз])|берез|marzo|march|mar/i, 3],
  [/апр|квіт|abril|april|apr/i, 4],
  [/ма[йя]|трав|mayo|may/i, 5],
  [/июн|черв|junio|june|jun/i, 6],
  [/июл|лип|julio|july|jul/i, 7],
  [/авг|серп|agosto|august|aug/i, 8],
  [/сен|верес|septiembre|september|sep/i, 9],
  [/окт|жовт|octubre|october|oct/i, 10],
  [/ноя|листопад|noviembre|november|nov/i, 11],
  [/дек|груд|diciembre|december|dec/i, 12],
];
const pad = (n) => String(n).padStart(2, '0');
function monthFromWord(word) {
  const w = (word || '').trim();
  for (const [re, m] of MONTHS) { if (re.test(w)) return m; }
  return 0;
}
function inferYear(month, day, today) {
  const y = today.getFullYear();
  const todayMonth = today.getMonth() + 1;
  const todayDay = today.getDate();
  if (month < todayMonth || (month === todayMonth && day < todayDay)) return y + 1;
  return y;
}
function parseEventDate(text, today = new Date()) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const num = /\b(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?\b/.exec(t);
  if (num) {
    const day = Number(num[1]);
    const month = Number(num[2]);
    let year = num[3] ? Number(num[3]) : 0;
    if (year && year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      if (!year) year = inferYear(month, day, today);
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }
  let best = null;
  const consider = (index, month, day, year4) => {
    if (!month || day < 1 || day > 31) return;
    const year = year4 ? Number(year4) : inferYear(month, day, today);
    const candidate = { index, iso: `${year}-${pad(month)}-${pad(day)}` };
    if (!best || candidate.index < best.index) best = candidate;
  };
  const dayFirst = /\b(\d{1,2})\s+(?:de\s+)?([A-Za-zА-Яа-яёЁЇїІіЄєҐґ]{3,})\.?(?:\s+(?:de\s+)?(\d{4}))?/u;
  const dm = dayFirst.exec(t);
  if (dm) consider(dm.index, monthFromWord(dm[2]), Number(dm[1]), dm[3]);
  const monthFirst = /(?<![\p{L}\d])([A-Za-zА-Яа-яёЁЇїІіЄєҐґ]{3,})\.?\s+(\d{1,2})(?:[^\d]{0,12}?(\d{4}))?/u;
  const mf = monthFirst.exec(t);
  if (mf) {
    const month = monthFromWord(mf[1]);
    if (month) consider(mf.index, month, Number(mf[2]), mf[3]);
  }
  return best ? best.iso : null;
}

// --- T150: mirror of dateFromUrl / isEventUrl / isCancelledTitle ---
function dateFromUrl(url) {
  if (!url) return null;
  const path = url.split(/[?#]/)[0];
  const m = /(\d{4})[-/](\d{2})[-/](\d{2})\/?$/.exec(path);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
const isEventUrl = (url) => !!url && /\/event\//.test(url);
const isCancelledTitle = (title) => /\(отмен/iu.test(title || '');

// --- T150: mirror of buildWorldafishaEvents' keep + date + cancel logic ---
function buildOne({ title, body = '', url = '' }, today) {
  // mirror order: snapshot skip is N/A here; /event/ gate; spain gate; date.
  if (!isEventUrl(url)) return null;
  const haystack = `${title} ${body} ${url}`;
  if (!isSpainEvent(haystack)) return null;
  if (hasNonSpainSignal(haystack) && !isSpainEvent(title)) return null;
  const start = dateFromUrl(url) ?? parseEventDate(haystack, today);
  return { start_date: start, cancelled: isCancelledTitle(title) };
}

test('T150 dateFromUrl: trailing YYYY-MM-DD slug → ISO date', () => {
  assert.equal(
    dateFromUrl('https://worldafisha.com/event/aleksandr-gudkov-valensiya-2026-11-09'),
    '2026-11-09',
  );
  // YYYY/MM/DD form and a trailing slash both accepted
  assert.equal(dateFromUrl('https://worldafisha.com/event/x-2026/11/09'), '2026-11-09');
  assert.equal(dateFromUrl('https://worldafisha.com/event/x-2026-11-09/'), '2026-11-09');
  // query/hash stripped before matching
  assert.equal(dateFromUrl('https://worldafisha.com/event/x-2026-11-09?utm=1'), '2026-11-09');
});

test('T150 dateFromUrl: no trailing date / implausible / empty → null', () => {
  assert.equal(dateFromUrl('https://worldafisha.com/persons/aleksandr-gudkov'), null);
  assert.equal(dateFromUrl('https://worldafisha.com/events/ispaniya'), null);
  assert.equal(dateFromUrl('https://worldafisha.com/event/x-2026-13-40'), null); // bad month/day
  assert.equal(dateFromUrl(''), null);
  assert.equal(dateFromUrl(null), null);
});

test('T150 isEventUrl: only /event/ URLs are real events', () => {
  assert.equal(isEventUrl('https://worldafisha.com/event/slava-valensiya-2026-06-21'), true);
  assert.equal(isEventUrl('https://worldafisha.com/persons/slava-komissarenko'), false);
  assert.equal(isEventUrl('https://worldafisha.com/events/ispaniya'), false);
  assert.equal(isEventUrl(''), false);
});

test('T150 build: /event/ url yields the slug date', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  // Spain signal in the title ("Мадрид") so the gate keeps it; slug carries the date.
  const out = buildOne(
    { title: 'Александр Гудков в Мадриде', url: 'https://worldafisha.com/event/aleksandr-gudkov-madrid-2026-11-09' },
    today,
  );
  assert.ok(out, '/event/ + Spain signal → kept');
  assert.equal(out.start_date, '2026-11-09');
});

test('T150 build: /persons/ artist page is dropped', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  assert.equal(
    buildOne({ title: 'Антон Лирник, Stand Up', url: 'https://worldafisha.com/persons/anton-lirnik-valensiya' }, today),
    null,
    '/persons/ profile page is not an event',
  );
});

test('T150 build: URL slug date is PREFERRED over a conflicting text date', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const out = buildOne(
    {
      title: 'Концерт в Валенсии 15 марта 2099', // text says March 2099
      url: 'https://worldafisha.com/event/concert-valensiya-2026-11-09', // url says Nov 2026
    },
    today,
  );
  assert.ok(out);
  assert.equal(out.start_date, '2026-11-09', 'url slug wins over the text-parsed date');
});

test('T150 build: no url date falls back to text parsing', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const out = buildOne(
    { title: 'Концерт в Валенсии 23 липня', url: 'https://worldafisha.com/event/concert-valensiya' },
    today,
  );
  assert.ok(out);
  assert.equal(out.start_date, '2026-07-23', 'falls back to parseEventDate when slug has no date');
});

test('T150 isCancelledTitle: "(отменен)" suffix flagged', () => {
  assert.equal(isCancelledTitle('Oxxxymiron (отменен)'), true);
  assert.equal(isCancelledTitle('Антон Лирник, Stand Up (отменен)'), true);
  assert.equal(isCancelledTitle('Иван Ургант - Живой Ургант'), false);
});

test('T150 build: cancelled flag surfaced on the draft tuple', () => {
  const today = new Date('2026-06-21T00:00:00Z');
  const out = buildOne(
    { title: 'Скриптонит в Валенсии (отменен)', url: 'https://worldafisha.com/event/skriptonit-valensiya-2026-10-09' },
    today,
  );
  assert.ok(out);
  assert.equal(out.cancelled, true);
  assert.equal(out.start_date, '2026-10-09', 'cancelled event still carries its real date');
});

test('parseEventDate: ISO, numeric and named RU/ES dates (existing — must stay green)', () => {
  const today = new Date('2026-06-20T00:00:00Z');
  assert.equal(parseEventDate('2026-07-10', today), '2026-07-10');
  assert.equal(parseEventDate('21.06.2026', today), '2026-06-21');
  assert.equal(parseEventDate('10/07/26', today), '2026-07-10');
  assert.equal(parseEventDate('21 июня 2026', today), '2026-06-21');
  assert.equal(parseEventDate('21 de junio de 2026', today), '2026-06-21');
  assert.equal(parseEventDate('10 julio', today), '2026-07-10');
});

test('parseEventDate: rolls a year-less past date to next occurrence', () => {
  const today = new Date('2026-06-20T00:00:00Z');
  // May already passed in 2026 → next year
  assert.equal(parseEventDate('5 мая', today), '2027-05-05');
});

test('parseEventDate: null when no date present', () => {
  assert.equal(parseEventDate('Концерт в Валенсии', new Date('2026-06-20')), null);
  assert.equal(parseEventDate('', new Date()), null);
  assert.equal(parseEventDate(null, new Date()), null);
});

// --- T145: REAL RU/UK strings the live ingest produced (year-less → inferred) ---
const TODAY = new Date('2026-06-21T00:00:00Z'); // fixed reference for determinism

test('T145: RU uppercase MONTH-first abbreviation "МАР 18" with explicit year', () => {
  assert.equal(
    parseEventDate('МАР 18 19:00 Виктория Складчикова в Аликанте: стендап 18 марта 2027', TODAY),
    '2027-03-18',
  );
});

test('T145: RU genitive "16 декабря" → year inferred (Dec seen in June = this year)', () => {
  assert.equal(parseEventDate('Группа «Нервы» в Валенсии: концерт 16 декабря', TODAY), '2026-12-16');
});

test('T145: RU uppercase "ДЕК 11" → inferred year', () => {
  assert.equal(parseEventDate('ДЕК 11 концерт в Валенсии', TODAY), '2026-12-11');
});

test('T145: RU genitive "30 ноября" → inferred year', () => {
  assert.equal(parseEventDate('«Чёрт знает что!» — Барселона — 30 ноября', TODAY), '2026-11-30');
});

test('T145: Ukrainian genitive "23 липня" (липня = July!) → inferred year', () => {
  assert.equal(parseEventDate('LP виступить у Валенсії ... 23 липня', TODAY), '2026-07-23');
});

test('T145: Ukrainian fuzzy "на початку липня" (early July, no day) → null (documented)', () => {
  // DECISION: relative/fuzzy ranges have no day; we return null rather than guess
  // first-of-month — an undated event still renders, a wrong date pin does not.
  assert.equal(parseEventDate('на початку липня у Валенсії стартує', TODAY), null);
});

test('T145: more RU 3-letter abbreviations, any case', () => {
  assert.equal(parseEventDate('ЯНВ 5 ...', TODAY), '2027-01-05'); // Jan seen in June → next year
  assert.equal(parseEventDate('фев 14 ...', TODAY), '2027-02-14');
  assert.equal(parseEventDate('ОКТ 3 ...', TODAY), '2026-10-03');
});

test('T145: Ukrainian nominative + genitive months', () => {
  assert.equal(parseEventDate('концерт 12 вересня', TODAY), '2026-09-12'); // September
  assert.equal(parseEventDate('подія 1 грудня', TODAY), '2026-12-01');     // December
  assert.equal(parseEventDate('виставка 8 березня 2027', TODAY), '2027-03-08'); // March, explicit yr
});

test('T145: same-month day-already-passed rolls to next year', () => {
  // today is 2026-06-21; June 10 already passed → 2027
  assert.equal(parseEventDate('10 июня', TODAY), '2027-06-10');
  // June 25 still ahead → this year
  assert.equal(parseEventDate('25 июня', TODAY), '2026-06-25');
});

test('T145: numeric DD-MM with no year infers next occurrence', () => {
  assert.equal(parseEventDate('05-01', TODAY), '2027-01-05'); // Jan → next year
  assert.equal(parseEventDate('30-12', TODAY), '2026-12-30'); // Dec → this year
});

test('T145: day-first preferred when it appears first in the text', () => {
  // "марта" (RU genitive) must not be mis-resolved; "март" stem hits month 3
  assert.equal(parseEventDate('18 марта 2027', TODAY), '2027-03-18');
});

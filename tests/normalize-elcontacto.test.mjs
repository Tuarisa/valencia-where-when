import test from 'node:test';
import assert from 'node:assert/strict';

// elcontacto.ru/valencia/events normalizer. Imports the ACTUAL pure functions
// (DB-free: buildElcontactoEvents skips the page_snapshot and never touches the DB).
// Fixtures are FAITHFUL to the live rows observed in the local DB (the board URL 404s,
// so the real rows are all chrome) PLUS synthetic real listings to prove extraction.

import {
  ELCONTACTO_SOURCE_KEY,
  isEventUrl,
  buildElcontactoEvents,
} from '../lib/pipeline/normalizers/elcontacto.ts';

// Helper: a raw source_items row shape (loose, like the live rows).
const row = ({
  id,
  title,
  raw_text = title,
  raw_json = '{"kind":"link_card"}',
  url = `https://elcontacto.ru/valencia/event-${id}`,
}) => ({ id, source_key: 'web:elcontacto', title, raw_text, raw_json, url });

const today = new Date('2026-06-21T00:00:00Z');

// --- The three REAL live rows (the board currently 404s) ---------------------
// id 244: the 404 page snapshot itself.
const real404 = {
  id: 244,
  source_key: 'web:elcontacto',
  title: '404 ошибка. Страница не найдена - Elcontacto.ru',
  raw_text:
    '404 ошибка. Страница не найдена - Elcontacto.ru \n\n 404 ошибка. Страница не найдена \n\n Объявления \n Блог',
  raw_json: '{"kind":"page_snapshot","meta":{"title":"404 ошибка. Страница не найдена - Elcontacto.ru"}}',
  url: 'https://elcontacto.ru/valencia/events',
};
// id 245: a mailto: link_card.
const realMailto = {
  id: 245,
  source_key: 'web:elcontacto',
  title: 'info@elcontacto.ru',
  raw_text: 'info@elcontacto.ru',
  raw_json: '{"kind":"link_card","source_page":"https://elcontacto.ru/valencia/events"}',
  url: 'mailto:info@elcontacto.ru',
};
// id 246: a classifieds-nav link_card to /ispaniya/.
const realNav = {
  id: 246,
  source_key: 'web:elcontacto',
  title: 'Объявления о продаже',
  raw_text: 'Объявления о продаже',
  raw_json: '{"kind":"link_card","source_page":"https://elcontacto.ru/valencia/events"}',
  url: 'https://elcontacto.ru/ispaniya/',
};

test('source key matches sources.json (id 24)', () => {
  assert.equal(ELCONTACTO_SOURCE_KEY, 'web:elcontacto');
});

test('isEventUrl: only on-site /valencia/ listings pass; chrome/off-site dropped', () => {
  assert.equal(isEventUrl('https://elcontacto.ru/valencia/event-konsert-21'), true);
  assert.equal(isEventUrl('https://elcontacto.ru/valencia/events'), false); // board index
  assert.equal(isEventUrl('mailto:info@elcontacto.ru'), false);
  assert.equal(isEventUrl('https://elcontacto.ru/ispaniya/'), false); // classifieds nav
  assert.equal(isEventUrl('https://example.com/valencia/x'), false); // off-site
  assert.equal(isEventUrl(null), false);
  assert.equal(isEventUrl('not a url'), false);
});

test('the three REAL live chrome rows produce ZERO events', () => {
  const out = buildElcontactoEvents([real404, realMailto, realNav], today);
  assert.deepEqual(out, [], '404 snapshot + mailto + classifieds-nav all dropped');
});

test('classifieds-board chrome is dropped even with an on-site /valencia/ URL (not URL-only)', () => {
  // Defense-in-depth: the live "Объявления о продаже" nav row is dropped today by its
  // off-/valencia/ URL. If the SAME label ever arrived under /valencia/, isElcontactoChrome
  // must still drop it — the drop must not depend on the URL path alone.
  const out = buildElcontactoEvents(
    [
      row({ id: 401, title: 'Объявления о продаже', url: 'https://elcontacto.ru/valencia/objyavleniya' }),
      row({ id: 402, title: 'Каталог фирм', url: 'https://elcontacto.ru/valencia/katalog' }),
      row({ id: 403, title: 'Подать объявление', url: 'https://elcontacto.ru/valencia/podat' }),
    ],
    today,
  );
  assert.deepEqual(out, [], 'classifieds-board nav labels dropped regardless of URL path');
});

test('a synthetic REAL listing parses date / title / venue / address / price', () => {
  const out = buildElcontactoEvents(
    [
      row({
        id: 301,
        title:
          'Концерт русской классики 16 декабря 2026 📍 Palau de la Música, Calle Colón 12, вход 25 eur',
      }),
    ],
    today,
  );
  assert.equal(out.length, 1);
  const d = out[0].draft;
  assert.equal(out[0].sourceItemId, 301);
  assert.equal(d.start_date, '2026-12-16', 'RU "16 декабря 2026" → ISO');
  assert.equal(d.title.startsWith('Концерт русской классики'), true);
  assert.equal(d.source, 'web:elcontacto');
  assert.equal(d.city, 'Valencia');
  assert.equal(d.country, 'Spain');
  assert.equal(d.language, 'ru');
  assert.ok(d.venue_name && d.venue_name.includes('Palau'), 'venue extracted from 📍 pin');
  assert.ok(d.address && d.address.includes('Colón'), 'street address extracted');
  assert.equal(d.price, '25 €', 'RU "25 eur" → normalized "25 €"');
});

test('year is inferred to the next occurrence when the listing omits it', () => {
  // "4 jul" with no year, reference 2026-06-21 → July is still ahead → 2026.
  const out = buildElcontactoEvents(
    [row({ id: 302, title: 'Fiesta de verano 4 jul, entrada gratis' })],
    today,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, '2026-07-04');
  assert.equal(out[0].draft.is_free, 1, 'gratis → free');
  assert.equal(out[0].draft.price, 'Free');
});

test('an undated real listing still emits (start_date null) but is not dropped', () => {
  const out = buildElcontactoEvents(
    [row({ id: 303, title: 'Выставка современного искусства в галерее' })],
    today,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, null, 'no date in text → null, not a guess');
  assert.equal(out[0].draft.title, 'Выставка современного искусства в галерее');
});

test('nav / email / legal chrome with an on-site URL is still dropped (isJunkCard)', () => {
  const out = buildElcontactoEvents(
    [
      row({ id: 304, title: 'Контакты', url: 'https://elcontacto.ru/valencia/kontakty' }),
      row({ id: 305, title: 'Правовая информация', url: 'https://elcontacto.ru/valencia/legal' }),
    ],
    today,
  );
  assert.deepEqual(out, [], 'nav + legal cards dropped even with a /valencia/ URL');
});

test('the 404/error title is dropped even on a non-snapshot listing URL', () => {
  const out = buildElcontactoEvents(
    [
      row({
        id: 306,
        title: '404 ошибка. Страница не найдена',
        url: 'https://elcontacto.ru/valencia/missing',
      }),
    ],
    today,
  );
  assert.deepEqual(out, [], 'error page dropped');
});

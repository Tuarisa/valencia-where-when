import test from 'node:test';
import assert from 'node:assert/strict';

// laganzua.net (web:laganzua) normalizer tests. Imports the ACTUAL pure functions
// (DB-free: buildLaganzuaEvents never touches the DB). Fixtures are FAITHFUL to the
// live source_items shape observed on the local DB:
//   • `link_card` rows whose title == raw_text (flattened anchor text)
//   • the DATE lives in the TITLE, Spanish day-first:
//       "Zaz en Madrid lunes 22 de junio de 2026"
//       "Bigsound Festival 2026 Valencia en Torrent, Valencia viernes 26 de junio de 2026"
//   • the URL slug carries ONLY a numeric id (…-1014366), never a date
//   • nav/chrome/news rows ("AGENDA DE CONCIERTOS", /noticias/…) must be dropped
//   • national highlight rows (Madrid/Barcelona/…) must be city-filtered out

import {
  LAGANZUA_SOURCE_KEY,
  buildLaganzuaEvents,
  isValenciaTitle,
  cleanLaganzuaTitle,
} from '../lib/pipeline/normalizers/laganzua.ts';

// Helper: a raw source_items row shape (loose, like the live rows). Default url is a
// real concert-listing URL (…/conciertos/<slug>-<id>).
const card = (id, title, url = `https://www.laganzua.net/conciertos/x-${id}-1010000`) => ({
  id,
  source_key: 'web:laganzua',
  title,
  raw_text: title,
  raw_json: '{"kind":"link_card","source_page":"https://www.laganzua.net/conciertos/valencia/este-fin-de-semana-2026"}',
  url,
});

// Deterministic reference date so year inference is stable (matches the live "today").
const TODAY = new Date('2026-06-21T00:00:00Z');

test('source key matches sources.json (web:laganzua)', () => {
  assert.equal(LAGANZUA_SOURCE_KEY, 'web:laganzua');
});

test('isValenciaTitle: Valencia / Torrent kept, Madrid / Barcelona rejected', () => {
  assert.equal(isValenciaTitle('Bigsound Festival 2026 Valencia en Torrent, Valencia viernes 26 de junio de 2026'), true);
  assert.equal(isValenciaTitle('Algo en València sábado 27 de junio de 2026'), true);
  assert.equal(isValenciaTitle('Zaz en Madrid lunes 22 de junio de 2026'), false);
  assert.equal(isValenciaTitle('Deep Purple - Vigo, Pontevedra'), false);
  assert.equal(isValenciaTitle(''), false);
  assert.equal(isValenciaTitle(null), false);
});

test('cleanLaganzuaTitle: strips the trailing "en <city> … <DD> de <month> de <YYYY>" tail', () => {
  assert.equal(
    cleanLaganzuaTitle('Bigsound Festival 2026 Valencia en Torrent, Valencia viernes 26 de junio de 2026'),
    'Bigsound Festival 2026 Valencia',
  );
  assert.equal(
    cleanLaganzuaTitle('Zaz en Madrid lunes 22 de junio de 2026'),
    'Zaz',
  );
  // no date tail → unchanged
  assert.equal(cleanLaganzuaTitle('Quevedo - Madrid'), 'Quevedo - Madrid');
});

test('buildLaganzuaEvents: keeps the Valencia dated row, parses date from the title', () => {
  const rows = [
    card(506, 'Bigsound Festival 2026 Valencia en Torrent, Valencia viernes 26 de junio de 2026',
      'https://www.laganzua.net/conciertos/bigsound-festival-2026-valencia-torrent-1014540'),
  ];
  const out = buildLaganzuaEvents(rows, TODAY);
  assert.equal(out.length, 1);
  const d = out[0].draft;
  assert.equal(out[0].sourceItemId, 506);
  assert.equal(d.title, 'Bigsound Festival 2026 Valencia');
  assert.equal(d.start_date, '2026-06-26');
  assert.equal(d.city, 'Valencia');
  assert.equal(d.country, 'Spain');
  assert.equal(d.source, 'web:laganzua');
  assert.equal(d.category, 'concert');
});

test('buildLaganzuaEvents: drops national highlight rows (Madrid/Barcelona/Vigo)', () => {
  const rows = [
    card(499, 'Zaz en Madrid lunes 22 de junio de 2026',
      'https://www.laganzua.net/conciertos/zaz-madrid-1014366'),
    card(513, 'Kany García en Las Palmas de Gran Canaria viernes 26 de junio de 2026',
      'https://www.laganzua.net/conciertos/kany-garcia-las-palmas-de-gran-canaria-1014292'),
    card(496, 'Deep Purple - Vigo, Pontevedra',
      'https://www.laganzua.net/conciertos/deep-purple-vigo-1015445'),
  ];
  const out = buildLaganzuaEvents(rows, TODAY);
  assert.equal(out.length, 0);
});

test('buildLaganzuaEvents: drops nav/chrome category anchors and news/footer links', () => {
  const rows = [
    // category nav anchors (no trailing numeric id) → not concert URLs
    card(480, 'AGENDA DE CONCIERTOS', 'https://www.laganzua.net/conciertos/agenda-conciertos'),
    card(481, 'CONCIERTOS GRATUITOS', 'https://www.laganzua.net/conciertos/conciertos-gratis'),
    // the weekend page itself
    card(485, 'Conciertos en Valencia Este Fin de Semana', 'https://www.laganzua.net/conciertos/valencia/este-fin-de-semana-2026'),
    // news article (Valencia named, but /noticias/ — not a concert)
    card(515, 'La Plazuela dan conciertos en … Valencia y otras fechas de su gira de 2026',
      'https://www.laganzua.net/noticias/32287-la-plazuela-dan-conciertos'),
    // footer / legal
    card(524, 'protección de datos', 'https://www.laganzua.net/privacidad.php'),
  ];
  const out = buildLaganzuaEvents(rows, TODAY);
  assert.equal(out.length, 0);
});

test('buildLaganzuaEvents: drops the full-page snapshot row', () => {
  const snap = {
    id: 478,
    source_key: 'web:laganzua',
    title: 'Conciertos en Valencia Este Fin de Semana, Agenda y Entradas',
    raw_text: 'La Ganzua … (whole page chrome) …',
    raw_json: '{"kind":"page_snapshot"}',
    url: 'https://www.laganzua.net/conciertos/valencia/este-fin-de-semana-2026',
  };
  const out = buildLaganzuaEvents([snap], TODAY);
  assert.equal(out.length, 0);
});

test('buildLaganzuaEvents: an undated Valencia listing still emits (start_date null)', () => {
  const rows = [
    card(900, 'Algun Grupo Local - Valencia',
      'https://www.laganzua.net/conciertos/algun-grupo-local-valencia-1099999'),
  ];
  const out = buildLaganzuaEvents(rows, TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, null);
  assert.equal(out[0].draft.city, 'Valencia');
});

test('normalizeLaganzua: marks EVERY processed row normalized (append-only), upserts kept', async () => {
  const { normalizeLaganzua } = await import('../lib/pipeline/normalizers/laganzua.ts');
  const marked = [];
  const upserts = [];
  // Minimal fake exec that recognises the three query shapes the normalizer issues.
  const fakeExec = async (strings) => {
    const q = strings.join(' ');
    if (/SELECT \* FROM source_items/.test(q)) {
      return [
        // kept (Valencia, dated)
        { id: 506, source_key: 'web:laganzua',
          title: 'Bigsound Festival 2026 Valencia en Torrent, Valencia viernes 26 de junio de 2026',
          raw_text: 'Bigsound Festival 2026 Valencia en Torrent, Valencia viernes 26 de junio de 2026',
          raw_json: '{"kind":"link_card"}',
          url: 'https://www.laganzua.net/conciertos/bigsound-festival-2026-valencia-torrent-1014540' },
        // dropped (Madrid)
        { id: 499, source_key: 'web:laganzua',
          title: 'Zaz en Madrid lunes 22 de junio de 2026',
          raw_text: 'Zaz en Madrid lunes 22 de junio de 2026',
          raw_json: '{"kind":"link_card"}',
          url: 'https://www.laganzua.net/conciertos/zaz-madrid-1014366' },
      ];
    }
    if (/INSERT INTO events/.test(q)) {
      upserts.push(q);
      return [{ inserted: true }];
    }
    if (/UPDATE source_items/.test(q)) {
      // capture the id bound last in the values
      marked.push(q);
      return [];
    }
    return [];
  };
  const res = await normalizeLaganzua({ exec: fakeExec });
  assert.equal(res.processed, 2);
  assert.equal(res.created, 1); // only the Valencia row upserted
  assert.equal(upserts.length, 1);
  // append-only: BOTH raw rows marked normalized, including the dropped Madrid one
  assert.equal(marked.length, 2);
});

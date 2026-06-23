import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAC_SOURCE_KEYS,
  parseCacDateLine,
  dateFromTitle,
  looksLikeCacTitle,
  splitCacBlocks,
  buildCacEvents,
  isCacPromo,
  normalizeCacSource,
  cacNormalizerFor,
} from "../lib/pipeline/normalizers/cac.ts";

// Fixtures faithful to the REAL shape observed on the live local DB (source_items for
// web:cac_*): per source ONE `page_snapshot` row whose raw_text is the flattened CAC
// listing — card blocks of <TITLE> [Temporal] [: DD/MM/YYYY] [– DD/MM/YYYY] | <DD Mon
// YYYY> "Recinto:" <VENUE> <DESC> <footer> — plus N `link_card` rows carrying only a
// bare title (date lives on the un-crawled detail page → those are dropped).

const REF = new Date("2026-06-21"); // deterministic "today"

// EXPOSICIONES snapshot — three exhibition blocks (leading-colon start + dash end span),
// one with only a start date, plus the title-embedded "A PARTIR DEL 2 DE JULIO" form.
const EXPO_TEXT = [
  // page chrome (nav/menus) — must be skipped, not become events
  "Exposiciones - LA CIUTAT",
  "Menú",
  "Español",
  "Exposiciones",
  "Ordenar por:",
  // block 1 — title carries an embedded start date AND a colon/dash span
  "📢NUEVA EXPOSICIÓN. ¡BAILAR! EL ARTE DE MOVERSE. A PARTIR DEL 2 DE JULIO",
  "Temporal",
  ": 02/07/2026",
  "– 10/01/2028",
  "Recinto:",
  "Museu de les Ciències",
  "Primera planta.- Una exposición interactiva, festiva e inclusiva que invita a descubrir la danza.",
  // block 2 — colon/dash span
  "PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA",
  "Temporal",
  ": 26/03/2026",
  "– 12/10/2026",
  "Recinto:",
  "Museu de les Ciències",
  "Exteriores -acceso libre- Exposición Park Eun Sun: esculturas en mármol.",
  // block 3 — single start date, no end (open-ended exhibition)
  "EXPOSICIÓN FOTOGRÁFICA «ASTROCIUTAT. EL UNIVERSO EN IMÁGENES»",
  "Temporal",
  ": 12/09/2025",
  "Recinto:",
  "Museu de les Ciències",
  "Planta baja.- Descubre la belleza del cosmos en la exposición ASTROCIUTAT.",
  // block 4 — DATELESS perennial exhibition: must be processed but NOT emitted (no invented date)
  "¡NOS GUSTA CONCIENCYARTE!",
  "Temporal",
  "Recinto:",
  "Museu de les Ciències",
  "Planta baja.- acceso libre- Recorre la historia del Museu de les Ciències.",
].join("\n");

const EXPO_ROW = {
  id: 972,
  source_key: "web:cac_exposiciones",
  title: "Exposiciones - LA CIUTAT",
  url: "https://cac.es/exposiciones/",
  raw_text: EXPO_TEXT,
  raw_json: JSON.stringify({
    kind: "page_snapshot",
    meta: { "og:image": "https://cac.es/wp-content/uploads/expo.jpg" },
  }),
};

// ACTIVIDADES snapshot — dated activities/conferences: numeric DD/MM/YYYY and the ES
// abbreviated "DD Mon YYYY – DD Mon YYYY" form, plus a DATELESS perennial activity.
const ACT_TEXT = [
  "Actividades - LA CIUTAT",
  "Menú",
  "Actividades",
  "Ordenar por:",
  // dateless perennial activity → processed, NOT emitted
  "MÚSICA EN ABIERTO CON BERKLEE",
  "Recinto:",
  "Museu de les Ciències",
  "La Ciutat en colaboración con Berklee College of Music ofrece una nueva edición.",
  "Ver más",
  // single numeric date
  "III EDICIÓN DEL CONCURSO DE ASTROFOTOGRAFÍA: ASTROCIUTAT",
  "12/06/2026",
  "Recinto:",
  "Museu de les Ciències",
  "La Ciutat ha convocado la tercera edición del concurso internacional de astrofotografía.",
  "Ver más",
  // ES abbreviated month form, single-day (start == end → no distinct end)
  "ECLIPSE. EL MOMENTO DE LA TOTALIDAD",
  "28 Abr 2026",
  "– 28 Abr 2026",
  "Recinto:",
  "Museu de les Ciències",
  "Jornada especial sobre eclipses con estreno de proyección y conferencia.",
  "Ver más",
  // ES abbreviated month form, multi-day range (distinct end kept)
  "CONCURSO ESCOLAR: DIBUJO DE NAVIDAD",
  "13 Oct 2025",
  "– 10 Dic 2025",
  "Recinto:",
  "Museu de les Ciències",
  "La Ciutat celebra un nuevo concurso de dibujo con el lema «Navidad en la Ciutat».",
  "Ver más",
].join("\n");

const ACT_ROW = {
  id: 910,
  source_key: "web:cac_actividades",
  title: "Actividades - LA CIUTAT",
  url: "https://cac.es/actividades/",
  raw_text: ACT_TEXT,
  raw_json: JSON.stringify({
    kind: "page_snapshot",
    meta: { "og:image": "https://cac.es/wp-content/uploads/act.jpg" },
  }),
};

// Chrome link_card rows — bare titles, no snapshot → ALL dropped.
const LINK_CARDS = [
  {
    id: 919,
    source_key: "web:cac_actividades",
    title: "RAMONA Y CAJAL. EL SECRETO DEL MUSEO. MUSICAL CIENTÍFICO",
    url: "https://cac.es/actividades/ramona-y-cajal/",
    raw_text: "RAMONA Y CAJAL. EL SECRETO DEL MUSEO. MUSICAL CIENTÍFICO",
    raw_json: JSON.stringify({ kind: "link_card", source_page: "https://cac.es/actividades/" }),
  },
  {
    id: 980,
    source_key: "web:cac_exposiciones",
    title: "EXPOSICIÓN MEMORIA",
    url: "https://cac.es/exposiciones/exposicion-memoria-museu-ciencies/",
    raw_text: "EXPOSICIÓN MEMORIA",
    raw_json: JSON.stringify({ kind: "link_card", source_page: "https://cac.es/exposiciones/" }),
  },
];

test("CAC_SOURCE_KEYS = the four cac listing sources", () => {
  assert.deepEqual([...CAC_SOURCE_KEYS], [
    "web:cac_actividades",
    "web:cac_agenda",
    "web:cac_exposiciones",
    "web:cac_museu",
  ]);
});

test("parseCacDateLine: numeric DD/MM/YYYY", () => {
  assert.equal(parseCacDateLine("12/06/2026"), "2026-06-12");
  assert.equal(parseCacDateLine("02/07/2026"), "2026-07-02");
});

test("parseCacDateLine: leading colon (expo start) and dash (expo end) decoration", () => {
  assert.equal(parseCacDateLine(": 26/03/2026"), "2026-03-26");
  assert.equal(parseCacDateLine("– 10/01/2028"), "2028-01-10");
});

test("parseCacDateLine: ES abbreviated 'DD Mon YYYY'", () => {
  assert.equal(parseCacDateLine("28 Abr 2026"), "2026-04-28");
  assert.equal(parseCacDateLine("10 Dic 2025"), "2025-12-10");
  assert.equal(parseCacDateLine("11 Nov 2025"), "2025-11-11");
});

test("parseCacDateLine: non-date lines → null", () => {
  assert.equal(parseCacDateLine("Recinto:"), null);
  assert.equal(parseCacDateLine("Museu de les Ciències"), null);
  assert.equal(parseCacDateLine("Temporal"), null);
  assert.equal(parseCacDateLine(""), null);
});

test("dateFromTitle: 'A PARTIR DEL 2 DE JULIO' → next-occurrence ISO", () => {
  const d = dateFromTitle(
    "📢NUEVA EXPOSICIÓN. ¡BAILAR! EL ARTE DE MOVERSE. A PARTIR DEL 2 DE JULIO",
    REF,
  );
  assert.equal(d, "2026-07-02");
  // a title with no date phrase → null
  assert.equal(dateFromTitle("EXPOSICIÓN MEMORIA", REF), null);
});

test("looksLikeCacTitle: upper-case titles yes, chrome/description/date no", () => {
  assert.equal(looksLikeCacTitle("EXPOSICIÓN MEMORIA"), true);
  assert.equal(looksLikeCacTitle("PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA"), true);
  // structural / chrome
  assert.equal(looksLikeCacTitle("Recinto:"), false);
  assert.equal(looksLikeCacTitle("Temporal"), false);
  assert.equal(looksLikeCacTitle("Ver más"), false);
  assert.equal(looksLikeCacTitle(": 02/07/2026"), false);
  assert.equal(looksLikeCacTitle("Exposiciones"), false);
  // a lower-case description sentence must NOT start a phantom block
  assert.equal(
    looksLikeCacTitle("Primera planta.- Una exposición interactiva, festiva e inclusiva."),
    false,
  );
});

test("isCacPromo: gift-voucher / golden-ticket promos are dropped, real titles kept (T179)", () => {
  // shop promos cac lists among real exhibitions
  assert.equal(isCacPromo("🎁 REGALA UNA EXPERIENCIA ÚNICA ESTAS NAVIDADES"), true);
  assert.equal(isCacPromo("GOLDEN TICKETS – 25º ANIVERSARIO DEL MUSEU DE LES CIÈNCIES"), true);
  assert.equal(isCacPromo("TARJETA REGALO HEMISFÈRIC"), true);
  // real exhibitions / events must NOT be flagged
  assert.equal(isCacPromo("PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA"), false);
  assert.equal(isCacPromo("METAMORFOSIS. EL PODER DE LA TRANSFORMACIÓN"), false);
  assert.equal(isCacPromo("¡BAILAR! EL ARTE DE MOVERSE"), false);
});

test("buildCacEvents: promo rows are not emitted", () => {
  const rows = [
    {
      id: 901,
      source_key: "web:cac_exposiciones",
      raw_text: [
        "🎁 REGALA UNA EXPERIENCIA ÚNICA ESTAS NAVIDADES",
        ": 18/12/2024",
        "– 07/01/2025",
        "Recinto:",
        "Hemisfèric",
        "PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA",
        ": 26/03/2026",
        "– 12/10/2026",
        "Recinto:",
        "Museu",
      ].join("\n"),
      raw_json: JSON.stringify({ kind: "page_snapshot" }),
      url: "https://cac.es/exposiciones/",
    },
  ];
  const titles = buildCacEvents(rows, REF).map((d) => d.draft.title);
  assert.ok(!titles.some((t) => /regala/i.test(t)), "promo dropped");
  assert.ok(titles.some((t) => t.startsWith("PARK EUN SUN")), "real exhibition kept");
});

test("splitCacBlocks: anchors blocks on titles, captures dates + venue, skips chrome", () => {
  const blocks = splitCacBlocks(EXPO_TEXT);
  const byTitle = Object.fromEntries(blocks.map((b) => [b.title, b]));

  const park = byTitle["PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA"];
  assert.ok(park, "Park Eun Sun block present");
  assert.equal(park.start, "2026-03-26");
  assert.equal(park.end, "2026-10-12");
  assert.equal(park.venue, "Museu de les Ciències");
  assert.equal(park.isExhibition, true); // "Temporal" status keyword present

  // chrome headers ("Exposiciones", "Menú", …) never became blocks
  assert.ok(!blocks.some((b) => /^(Exposiciones|Menú|Español|Ordenar por)/.test(b.title)));
});

test("buildCacEvents (exposiciones): exhibition category + start/end SPAN, dateless dropped", () => {
  const events = buildCacEvents([EXPO_ROW, ...LINK_CARDS], REF);
  const byTitle = Object.fromEntries(events.map((e) => [e.draft.title, e.draft]));

  // 3 dated exhibition blocks emitted; the dateless ¡NOS GUSTA CONCIENCYARTE! dropped;
  // the link_card rows (EXPOSICIÓN MEMORIA / RAMONA Y CAJAL) dropped.
  assert.equal(events.length, 3);
  assert.ok(!byTitle["¡NOS GUSTA CONCIENCYARTE!"], "dateless perennial NOT emitted (no invented date)");
  assert.ok(!byTitle["EXPOSICIÓN MEMORIA"], "link_card dropped");

  // block 1 — title-embedded date used (no leading-colon date precedes), span kept.
  const bailar = events.find((e) => e.draft.title.includes("BAILAR"));
  assert.ok(bailar, "¡BAILAR! exhibition present");
  assert.equal(bailar.draft.start_date, "2026-07-02");
  assert.equal(bailar.draft.end_date, "2028-01-10"); // distinct end → spanning bar
  assert.equal(bailar.draft.category, "выставка"); // exhibition category (T175 EXPO_TEXT_RE)
  assert.equal(bailar.draft.city, "Valencia");
  assert.equal(bailar.draft.country, "Spain");
  assert.equal(bailar.draft.source, "web:cac_exposiciones");
  assert.equal(bailar.draft.image_url, "https://cac.es/wp-content/uploads/expo.jpg");

  // block 2 — colon/dash span
  const park = byTitle["PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA"];
  assert.equal(park.start_date, "2026-03-26");
  assert.equal(park.end_date, "2026-10-12");
  assert.equal(park.category, "выставка");

  // block 3 — single start, no end span
  const astro = events.find((e) => e.draft.title.includes("ASTROCIUTAT"));
  assert.equal(astro.draft.start_date, "2025-09-12");
  assert.equal(astro.draft.end_date, null);
  assert.equal(astro.draft.category, "выставка");
});

test("buildCacEvents (actividades): dated events, ES-month range, dateless dropped", () => {
  const events = buildCacEvents([ACT_ROW], REF);
  const byTitle = Object.fromEntries(events.map((e) => [e.draft.title, e.draft]));

  // 3 dated blocks; the dateless MÚSICA EN ABIERTO CON BERKLEE dropped.
  assert.equal(events.length, 3);
  assert.ok(!byTitle["MÚSICA EN ABIERTO CON BERKLEE"], "dateless activity NOT emitted");

  // numeric single date → plain event (culture), no end span.
  const astro = events.find((e) => e.draft.title.includes("ASTROFOTOGRAFÍA"));
  assert.ok(astro);
  assert.equal(astro.draft.start_date, "2026-06-12");
  assert.equal(astro.draft.end_date, null);
  assert.equal(astro.draft.category, "culture"); // agenda/actividades default = plain event
  assert.equal(astro.draft.source, "web:cac_actividades");

  // ES-month single-day (28 Abr 2026 – 28 Abr 2026): start == end → no distinct end.
  const eclipse = byTitle["ECLIPSE. EL MOMENTO DE LA TOTALIDAD"];
  assert.equal(eclipse.start_date, "2026-04-28");
  assert.equal(eclipse.end_date, null);

  // ES-month multi-day range: distinct end kept.
  const navidad = byTitle["CONCURSO ESCOLAR: DIBUJO DE NAVIDAD"];
  assert.equal(navidad.start_date, "2025-10-13");
  assert.equal(navidad.end_date, "2025-12-10");
});

test("buildCacEvents: a snapshot-less batch (link_cards only) yields nothing", () => {
  assert.equal(buildCacEvents(LINK_CARDS, REF).length, 0);
});

test("normalizeCacSource: idempotent over injected exec, marks every row normalized", async () => {
  const pending = [EXPO_ROW, LINK_CARDS[1]]; // one snapshot + one link_card (same source)
  const marked = new Set();
  let inserts = 0;

  const exec = async (strings) => {
    const q = strings.join(" ");
    if (/SELECT \* FROM source_items/i.test(q)) return pending;
    if (/INSERT INTO events/i.test(q)) {
      inserts++;
      return [{ inserted: true }];
    }
    return [];
  };
  const tracking = (strings, ...vals) => {
    const q = strings.join(" ");
    if (/UPDATE source_items/i.test(q)) marked.add(vals[vals.length - 1]);
    return exec(strings, ...vals);
  };

  const res = await normalizeCacSource("web:cac_exposiciones", { exec: tracking });
  assert.equal(res.processed, pending.length);
  assert.equal(res.created, 3); // 3 dated exhibitions upserted
  assert.equal(inserts, 3);
  // Every raw row (snapshot + the link_card) marked normalized — append-only.
  for (const r of pending) assert.ok(marked.has(r.id), `row ${r.id} marked`);
});

test("cacNormalizerFor: returns a no-arg normalizer bound to its source key", () => {
  const fn = cacNormalizerFor("web:cac_agenda");
  assert.equal(typeof fn, "function");
  assert.equal(fn.length, 0); // no-arg, registry-shaped
});

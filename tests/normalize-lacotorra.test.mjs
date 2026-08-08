import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LACOTORRA_SOURCE_KEY,
  parseLacotorraDate,
  buildLacotorraEvents,
  buildLacotorraDetailMap,
  normalizeLacotorra,
  isValenciaRegion,
  isHeadliner,
} from "../lib/pipeline/normalizers/lacotorra.ts";
import { extractLacotorraDetail } from "../lib/pipeline/ingest.ts";

// Fixtures faithful to the REAL shape observed on the live local DB (source_items
// for web:lacotorra): the events live in a SINGLE `page_snapshot` row whose raw_text
// is the flattened agenda — blocks of <Title> [<City>] <Description> <DateRange>
// <Venue>; every `link_card` row is nav/legal chrome and must be dropped.

const REF = new Date("2026-06-21"); // deterministic "today"

// Trimmed but structurally faithful snapshot (chrome header, then 4 event blocks:
// one featured block WITHOUT a city line, then Valencia / Madrid / Barcelona blocks).
const SNAPSHOT_TEXT = [
  "Мероприятия Валенсии",
  "Все",
  "Стендап",
  // featured block — NO separate city line (city baked into the title)
  "Выставка PUPAE в арт-хабе La Cotorra в Валенсии",
  "Серия работ из строительных материалов о метаморфозах",
  "29 May 2026, 10:00 - 26 Jun 2026, 20:00",
  "La Cotorra Galería",
  // Valencia block — WITH city line
  "Выставка о Фриде Кало в Валенсии",
  "Валенсия",
  "Посетителей ждет театрализованное погружение в жизнь художницы...",
  "9 Jun 2026, 10:00 - 5 Aug 2026, 12:00",
  "Ateneo Mercantil de Valencia",
  // Madrid block — WITH city line. A HEADLINER (BTS) so it survives the T170 hybrid
  // city filter (a non-headliner Madrid event would be dropped); still exercises the
  // RU-city-line → CITY_MAP=Madrid path and the multi-day date parse.
  "Концерт группы BTS в Мадриде",
  "Мадрид",
  "Группа выступит в рамках мирового тура десятки лет...",
  "26 Mar 2026, 12:00 - 31 Dec 2026, 12:00",
  "Palacio de Gaviria",
  // Barcelona single-day block
  "Концерт Стинга в Барселоне",
  "Барселона",
  "Музыкант выступит в рамках Les Nits Occident 2026...",
  "7 Jul 2026, 22:00",
  "Jardins del Palau de Pedralbes",
].join("\n");

const SNAPSHOT_ROW = {
  id: 470,
  source_key: LACOTORRA_SOURCE_KEY,
  title: "Мероприятия Валенсии. Афиша для всей семьи.",
  url: "https://lacotorra.io/events",
  raw_text: SNAPSHOT_TEXT,
  raw_json: JSON.stringify({
    kind: "page_snapshot",
    meta: { "og:image": "https://lacotorra.io/uploads/OG-image.png" },
  }),
};

// Chrome link_card rows — ALL must be dropped (privacy policy, category nav, anchors).
const CHROME_ROWS = [
  {
    id: 471,
    source_key: LACOTORRA_SOURCE_KEY,
    title: "Política de Privacidad",
    url: "https://lacotorra.io/privacy-policy",
    raw_text: "Política de Privacidad",
    raw_json: JSON.stringify({ kind: "link_card", source_page: "https://lacotorra.io/events" }),
  },
  {
    id: 473,
    source_key: LACOTORRA_SOURCE_KEY,
    title: "Религиозные события",
    url: "https://lacotorra.io/events?category=religioznye-sobytiya",
    raw_text: "Религиозные события",
    raw_json: JSON.stringify({ kind: "link_card", source_page: "https://lacotorra.io/events" }),
  },
  {
    id: 475,
    source_key: LACOTORRA_SOURCE_KEY,
    title: "Предстоящие мероприятия",
    url: "https://lacotorra.io/events#upcoming-events",
    raw_text: "Предстоящие мероприятия",
    raw_json: JSON.stringify({ kind: "link_card", source_page: "https://lacotorra.io/events" }),
  },
];

test("source key matches sources.json (web:lacotorra)", () => {
  assert.equal(LACOTORRA_SOURCE_KEY, "web:lacotorra");
});

test("parseLacotorraDate: multi-day range → start/end ISO, start time DROPPED (Bug 3)", () => {
  // Bug 3: lacotorra renders a generic OPENING-HOURS time for a multi-day block (e.g.
  // the Harry Potter drone show's agenda line read "12:00" though it's a 22:30 night
  // show). For a multi-day range the time is unreliable → null (a wrong time is worse).
  const r = parseLacotorraDate("9 Jun 2026, 10:00 - 5 Aug 2026, 12:00");
  assert.equal(r.start, "2026-06-09");
  assert.equal(r.end, "2026-08-05");
  assert.equal(r.startTime, null);
});

test("parseLacotorraDate: single day → start only, null end, time KEPT", () => {
  const r = parseLacotorraDate("7 Jul 2026, 22:00");
  assert.equal(r.start, "2026-07-07");
  assert.equal(r.end, null);
  assert.equal(r.startTime, "22:00"); // single-day blocks keep their (reliable) time
});

test("parseLacotorraDate: same-day range → time KEPT (Bug 3 single-day exception)", () => {
  const r = parseLacotorraDate("26 Jun 2026, 22:30 - 26 Jun 2026, 23:30");
  assert.equal(r.start, "2026-06-26");
  assert.equal(r.startTime, "22:30"); // end === start ⇒ single day ⇒ trust the time
});

test("parseLacotorraDate: non-date line → all null", () => {
  assert.deepEqual(parseLacotorraDate("Ateneo Mercantil de Valencia"), {
    start: null,
    end: null,
    startTime: null,
  });
});

test("buildLacotorraEvents: parses snapshot blocks, drops chrome", () => {
  const events = buildLacotorraEvents([SNAPSHOT_ROW, ...CHROME_ROWS], REF);
  // 4 event blocks in the snapshot; 0 from chrome link_cards.
  assert.equal(events.length, 4);

  const byTitle = Object.fromEntries(events.map((e) => [e.draft.title, e.draft]));

  // Featured block (no city line): title 2-back, date parsed, venue forward.
  const pupae = byTitle["Выставка PUPAE в арт-хабе La Cotorra в Валенсии"];
  assert.ok(pupae, "PUPAE event present");
  assert.equal(pupae.start_date, "2026-05-29");
  assert.equal(pupae.end_date, "2026-06-26");
  assert.equal(pupae.start_time, null); // Bug 3: multi-day block → unreliable time dropped
  assert.equal(pupae.venue_name, "La Cotorra Galería");
  assert.equal(pupae.city, "Valencia"); // no city line → default Valencia
  assert.equal(pupae.country, "Spain");
  assert.equal(pupae.source, "web:lacotorra");
  assert.equal(pupae.language, "ru");
  assert.equal(pupae.image_url, "https://lacotorra.io/uploads/OG-image.png");

  // Valencia block (with city line): correct title (not the description/city).
  const frida = byTitle["Выставка о Фриде Кало в Валенсии"];
  assert.ok(frida, "Frida event present");
  assert.equal(frida.start_date, "2026-06-09");
  assert.equal(frida.venue_name, "Ateneo Mercantil de Valencia");
  assert.equal(frida.city, "Valencia");

  // Madrid block (a headliner — survives T170): city mapped from the RU city line.
  const bts = byTitle["Концерт группы BTS в Мадриде"];
  assert.ok(bts, "Madrid headliner (BTS) event present");
  assert.equal(bts.city, "Madrid");
  assert.equal(bts.start_date, "2026-03-26");
  assert.equal(bts.venue_name, "Palacio de Gaviria");

  // Barcelona single-day block: end null, city mapped.
  const sting = byTitle["Концерт Стинга в Барселоне"];
  assert.ok(sting, "Sting event present");
  assert.equal(sting.city, "Barcelona");
  assert.equal(sting.start_date, "2026-07-07");
  assert.equal(sting.end_date, null);
});

test("buildLacotorraEvents: a snapshot-less batch yields nothing", () => {
  assert.equal(buildLacotorraEvents(CHROME_ROWS, REF).length, 0);
});

// Regression for the "8 raw rows → 56 events looks like an explosion" symptom.
// Diagnosis (live local DB, web:lacotorra): NOT a bug. The single `page_snapshot`
// row is a flattened multi-event agenda — on the live data 56 DATE-anchored blocks
// = 56 distinct, dated events; the other 7 raw rows are chrome link_cards (dropped).
// This test proves the invariant the symptom is really about: one snapshot yields
// EXACTLY one event per DATE line, every event is DISTINCT (no title|date dup, no
// row fan-out) and DATED, and header/category blocks between events don't leak in.
test("buildLacotorraEvents: multi-block snapshot does NOT explode — 1 event per DATE line, all distinct & dated", () => {
  // 6 real event blocks. Two structural traps that an exploding parser would trip on:
  //  - a category/header block ("Предстоящие мероприятия") sitting BETWEEN events,
  //  - a block whose own city line is followed by another event (no shared lines).
  // The non-Valencia blocks here are HEADLINERS (Linkin Park / Garbage / Sting / Bruno
  // Mars) so all 6 survive the T170 hybrid filter — keeping this test focused on the
  // PARSING invariant (1 event per DATE line, no fan-out), not the city policy (which
  // has its own tests). A non-headliner Madrid block would be (correctly) dropped.
  const MULTI = [
    "Мероприятия Валенсии", // page header chrome (no date → not a block)
    "Все",
    "Выставка PUPAE в арт-хабе La Cotorra в Валенсии",
    "Серия работ из строительных материалов о метаморфозах",
    "29 May 2026, 10:00 - 26 Jun 2026, 20:00",
    "La Cotorra Galería",
    "Предстоящие мероприятия", // section header BETWEEN events — must NOT become an event
    "Выставка про мир «Алисы в Стране чудес» в CaixaForum Валенсии",
    "Валенсия",
    "Экспозиция объединяет 255 произведений искусства...",
    "16 Apr 2026, 12:00 - 12 Oct 2026, 19:00",
    "CaixaForum Valencia",
    "Концерты Linkin Park в Мадриде",
    "Мадрид",
    "Группа выступит в рамках мирового тура...",
    "26 Mar 2026, 12:00 - 31 Dec 2026, 12:00",
    "Palacio de Gaviria",
    "Концерт Garbage в Мадриде",
    "Мадрид",
    "Перенеситесь в Лондон XIX века на один вечер...",
    "24 Apr 2026, 21:00 - 14 Aug 2026, 21:00",
    "Ilustre Colegio Oficial de Médicos de Madrid",
    "Концерт Стинга в Барселоне",
    "Барселона",
    "Музыкант выступит...",
    "7 Jul 2026, 22:00", // single-day → null end
    "Jardins del Palau de Pedralbes",
    "Концерт Бруно Марса в Мадриде",
    "Мадрид",
    "Один концерт в столице...",
    "10 Jul 2026, 21:00", // single-day, LAST block (no trailing venue line follows it)
  ].join("\n");

  const row = { ...SNAPSHOT_ROW, id: 480, raw_text: MULTI };
  const events = buildLacotorraEvents([row, ...CHROME_ROWS], REF);

  // One event per DATE line, no fan-out: 6 DATE lines → exactly 6 events.
  const dateLineCount = MULTI.split("\n").filter((l) =>
    /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4},\s*\d{1,2}:\d{2}/.test(l.trim()),
  ).length;
  assert.equal(dateLineCount, 6);
  assert.equal(events.length, 6, "exactly one event per DATE line — no explosion");

  // Every event is DATED (the symptom's core: 56 events were all dated).
  assert.ok(events.every((e) => e.draft.start_date), "every event has a start_date");

  // Every event is DISTINCT — no duplicate title|date key (no row/block fan-out).
  const keys = events.map((e) => `${e.draft.title.toLowerCase()}|${e.draft.start_date}`);
  assert.equal(new Set(keys).size, events.length, "all title|date keys distinct");

  // The section-header block must NOT leak in as an event title.
  const titles = events.map((e) => e.draft.title);
  assert.ok(
    !titles.some((t) => /^(Предстоящие мероприятия|Все|Мероприятия Валенсии)$/.test(t)),
    "no chrome/header block became an event",
  );

  // The last block (single-day, no trailing venue line) is still emitted, dated,
  // and end-less — proves the walk-back anchoring handles the final block.
  const bruno = events.find((e) => e.draft.title.startsWith("Концерт Бруно Марса"));
  assert.ok(bruno, "final single-day block emitted");
  assert.equal(bruno.draft.start_date, "2026-07-10");
  assert.equal(bruno.draft.end_date, null);
});

test("buildLacotorraEvents: de-dupes identical title+date within a snapshot", () => {
  const dupRow = {
    ...SNAPSHOT_ROW,
    id: 999,
    raw_text: [
      "Концерт Стинга в Барселоне",
      "Барселона",
      "Музыкант выступит...",
      "7 Jul 2026, 22:00",
      "Jardins del Palau de Pedralbes",
      // exact repeat of the same block
      "Концерт Стинга в Барселоне",
      "Барселона",
      "Музыкант выступит...",
      "7 Jul 2026, 22:00",
      "Jardins del Palau de Pedralbes",
    ].join("\n"),
  };
  const events = buildLacotorraEvents([dupRow], REF);
  assert.equal(events.length, 1);
});

// ── T170: HYBRID city filter ─────────────────────────────────────────────────
// KEEP every Comunitat Valenciana event; from OTHER Spanish cities keep ONLY curated
// international headliners; DROP the rest. Deterministic (T140 — JS, no LLM).

test("isValenciaRegion: keeps Comunitat Valenciana (city in title), incl. Alicante province", () => {
  assert.equal(isValenciaRegion("Valencia", null, "Выставка о Фриде Кало в Валенсии"), true);
  // Alicante is a CV province — kept even though it's not the city of València.
  assert.equal(isValenciaRegion("Alicante", null, "Концерт Pablo Alborán в Аликанте"), true);
  // Ademús (Valencia province town) printed without the region word.
  assert.equal(isValenciaRegion("Valencia", null, "Фестиваль цветения лаванды в Адемусе"), true);
  // Geocoded location_notes region label is enough on its own.
  assert.equal(isValenciaRegion(null, "Comarca de València, Comunitat Valenciana, España", null), true);
});

test("isValenciaRegion: drops other Spanish cities even when the city column defaults to Valencia", () => {
  // The stored city column is unreliable (defaults to 'Valencia'); the title's
  // "в Мадриде"/"в Гранаде" must win → NOT Valencia region.
  assert.equal(isValenciaRegion("Madrid", null, "Выставка Сальвадора Дали в Мадриде"), false);
  assert.equal(isValenciaRegion("Valencia", null, "Концерт Pablo Alborán в Гранаде"), false);
  assert.equal(isValenciaRegion("Valencia", null, "Концерт Pablo Alborán в Мериде"), false);
  assert.equal(isValenciaRegion("Barcelona", null, "Фестиваль Grec в Барселоне"), false);
});

test("isValenciaRegion (T154 real-data fix): Puerto de Sagunto is Valencia province — KEPT", () => {
  // REAL title from the live 2026-08 snapshot (id 2137). A bare "пуэрто" stem in
  // NON_CV_STEMS used to poison "Пуэрто-де-Сагунто" and mis-drop this CV event.
  assert.equal(
    isValenciaRegion("Valencia", null, "Сагунто и Пуэрто-де-Сагунто отпразднуют дни святых покровителей"),
    true,
  );
});

test("isHeadliner (T154): The Weeknd kept from the REAL index; generic 'уикенд' events are not", () => {
  // REAL titles from the live 2026-08 snapshot.
  assert.equal(isHeadliner("Концерт The Weeknd в Мадриде"), true);
  assert.equal(isHeadliner("Концерт The Weeknd в Барселоне"), true);
  // The RU word "уикенд" alone must NOT trigger the allowlist (generic word).
  assert.equal(isHeadliner("Гастрономический уикенд в Мадриде"), false);
});

test("isHeadliner: matches curated international acts, not generic events", () => {
  assert.equal(isHeadliner("Концерты Linkin Park в Мадриде"), true);
  assert.equal(isHeadliner("Концерт группы BTS в Мадриде"), true);
  assert.equal(isHeadliner("Концерт Стинга в Барселоне"), true); // "стинг"
  assert.equal(isHeadliner("Концерт Бруно Марса в Мадриде"), true);
  assert.equal(isHeadliner("Концерт Garbage в Ла-Корунье"), true);
  assert.equal(isHeadliner("Шоу Cirque du Soleil в Валенсии"), true);
  assert.equal(isHeadliner("Río Babel 2026 в Мадриде"), false);
  assert.equal(isHeadliner("Выставка Сальвадора Дали в Мадриде"), false);
});

test("buildLacotorraEvents (T170): Valencia kept, small Madrid dropped, Madrid headliner kept", () => {
  const SNAP = [
    // Valencia event → KEEP
    "Выставка о Фриде Кало в Валенсии",
    "Валенсия",
    "Театрализованное погружение в жизнь художницы...",
    "9 Jun 2026, 10:00 - 5 Aug 2026, 12:00",
    "Ateneo Mercantil de Valencia",
    // small Madrid event (not a headliner) → DROP
    "Выставка с редкими работами Сальвадора Дали в Мадриде",
    "Мадрид",
    "Скульптуры известного художника...",
    "26 Mar 2026, 12:00 - 31 Dec 2026, 12:00",
    "Palacio de Gaviria",
    // Madrid HEADLINER (Linkin Park) → KEEP despite being in Madrid
    "Концерты Linkin Park в Мадриде",
    "Мадрид",
    "Группа выступит в рамках мирового тура...",
    "29 Jun 2026, 21:00",
    "Estadio Metropolitano",
  ].join("\n");

  const row = { ...SNAPSHOT_ROW, id: 700, raw_text: SNAP };
  const events = buildLacotorraEvents([row], REF);
  const titles = events.map((e) => e.draft.title);

  // Exactly 2 emitted: the Valencia event + the Madrid headliner; the small Madrid
  // event is excluded (not upserted → never reaches the feed).
  assert.equal(events.length, 2);
  assert.ok(titles.includes("Выставка о Фриде Кало в Валенсии"), "Valencia event kept");
  assert.ok(titles.some((t) => t.startsWith("Концерты Linkin Park")), "Madrid headliner kept");
  assert.ok(
    !titles.some((t) => t.includes("Сальвадора Дали")),
    "small Madrid event dropped (excluded from feed)",
  );
});

// ── T201: full-text detail pages ─────────────────────────────────────────────
// USER report (2026-08-08): descriptions were the index page's "…"-cut teasers while
// the detail page (`/events/<slug>`) holds the FULL article. Fixtures below are
// VERBATIM from the LIVE site + the live local DB (snapshot id 2137, lines 234–238,
// and https://lacotorra.io/events/vr-vystavka-o-zatmenii-v-valensii fetched
// 2026-08-08) — real strings, not synthetic (project lesson: aggregators lie).

const VR_DETAIL_URL = "https://lacotorra.io/events/vr-vystavka-o-zatmenii-v-valensii";

// Trimmed but VERBATIM segments of the live detail page: head metas, h1, teaser p,
// and the full descr-section (incl. the trailing photo-credit paragraph).
const VR_DETAIL_HTML = `<!DOCTYPE html>
<html lang="ru"><head>
<title>VR-выставка о затмении проходит в Валенсии с 20 июля</title>
<meta name="description" content="Иммерсивная выставка с VR и ИИ позволит пережить солнечное затмение 12 августа как космонавт. Las Naves в Валенсии, с 20 июля по 31 августа, вход свободный">
<meta property="og:description" content="Иммерсивная выставка с VR и ИИ позволит пережить солнечное затмение 12 августа как космонавт. Las Naves в Валенсии, с 20 июля по 31 августа, вход свободный">
<meta property="og:image" content="https://lacotorra.io/uploads/afisha/A_VR_exhibition_eclipse_Valencia.jpg">
</head><body>
<main class="main container">
<div class="event-description inner-event"><div class="text-box"><div class="align-m">
<h1 class="h2">VR-выставка о затмении в Валенсии</h1>
<p>Выставка совмещает VR и ИИ, вход свободный</p>
</div></div></div>
<div class="sticky-nav-bar"><p class="h4">О мероприятии</p></div>
<section class="descr-section">
<p>С 20 июля по 31 августа 2026 года в Валенсии, в Centro de Innovación Social y Urbana Las Naves, будет работать иммерсивная выставка о солнечном затмении. Проект подготовила мэрия Валенсии через программу Valencia Innovation Capital. Выставка сочетает виртуальную реальность и искусственный интеллект и превращает посетителей в космонавтов.</p>
<p>Благодаря симуляции гости смогут увидеть, как выглядит выравнивание Солнца, Земли и Луны и почему возникает эффект затмения, а также рассмотреть явления, почти незаметные с поверхности Земли: солнечную корону, «бриллиантовое кольцо» и Четки Бейли. Выставка расскажет и о том, как затмение выглядело в Валенсии в 1905 году (&nbsp;в последний раз, когда город наблюдал это явление),&nbsp;и с какими метеорологическими трудностями тогда столкнулись астрономы.</p>
<p>Выставка рассчитана на любую аудиторию, включая семьи, молодежь и организованные группы. Вход свободный.</p>
<p>Адрес: calle Joan Verdeguer, 16, Валенсия. Часы работы: с 10:30 до 18:30.</p>
<p><em>Фото:&nbsp;shutterstock.com</em></p>
</section>
</main></body></html>`;

test("extractLacotorraDetail (T201): full descr-section text, photo credit dropped, event og:image", () => {
  const d = extractLacotorraDetail(VR_DETAIL_HTML);
  assert.equal(d.title, "VR-выставка о затмении в Валенсии");
  assert.ok(d.full_text, "full text extracted");
  // Full article, NOT the 45-char teaser: all 4 real paragraphs survive.
  assert.ok(d.full_text.length > 900, `full text is long (got ${d.full_text.length})`);
  assert.ok(d.full_text.startsWith("С 20 июля по 31 августа 2026 года в Валенсии"));
  assert.ok(d.full_text.includes("«бриллиантовое кольцо» и Четки Бейли"));
  assert.ok(d.full_text.includes("Адрес: calle Joan Verdeguer, 16, Валенсия"));
  // Paragraph breaks preserved (blank line between real <p> blocks).
  assert.ok(d.full_text.includes("\n\n"), "paragraph breaks kept");
  // The trailing photo-credit paragraph is chrome, not description.
  assert.ok(!d.full_text.includes("Фото:"), "photo credit dropped");
  assert.ok(!d.full_text.includes("shutterstock"), "photo credit dropped fully");
  // Event-SPECIFIC og:image (the index page serves one generic banner for all).
  assert.equal(d.meta["og:image"], "https://lacotorra.io/uploads/afisha/A_VR_exhibition_eclipse_Valencia.jpg");
});

test("extractLacotorraDetail (T201): no descr-section → falls back to og:description", () => {
  const html = `<html><head>
<meta property="og:description" content="Иммерсивная выставка с VR и ИИ позволит пережить солнечное затмение 12 августа как космонавт. Las Naves в Валенсии, с 20 июля по 31 августа, вход свободный">
</head><body><h1 class="h2">VR-выставка о затмении в Валенсии</h1></body></html>`;
  const d = extractLacotorraDetail(html);
  assert.ok(d.full_text.startsWith("Иммерсивная выставка с VR и ИИ"));
});

// Real-shaped `event_detail` raw rows (what parseLacotorra upserts into source_items).
const VR_DETAIL_ROW = {
  id: 3001,
  source_key: LACOTORRA_SOURCE_KEY,
  item_type: "event_detail",
  external_id: VR_DETAIL_URL,
  url: VR_DETAIL_URL,
  raw_text:
    "С 20 июля по 31 августа 2026 года в Валенсии, в Centro de Innovación Social y Urbana Las Naves, будет работать иммерсивная выставка о солнечном затмении. Проект подготовила мэрия Валенсии через программу Valencia Innovation Capital. Выставка сочетает виртуальную реальность и искусственный интеллект и превращает посетителей в космонавтов.\n\nВыставка рассчитана на любую аудиторию, включая семьи, молодежь и организованные группы. Вход свободный.",
  raw_json: JSON.stringify({
    kind: "event_detail",
    source_page: "https://lacotorra.io/events",
    meta: { "og:image": "https://lacotorra.io/uploads/afisha/A_VR_exhibition_eclipse_Valencia.jpg" },
  }),
};

test("buildLacotorraDetailMap (T201): keyed by URL, freshest row wins, stubs skipped", () => {
  const older = {
    ...VR_DETAIL_ROW,
    id: 2900,
    raw_text: "Устаревший текст прошлой выгрузки",
  };
  const stub = {
    id: 3002,
    source_key: LACOTORRA_SOURCE_KEY,
    item_type: "event_detail",
    url: "https://lacotorra.io/events/kakoe-to-sobytie-bez-teksta",
    raw_text: null,
    raw_json: JSON.stringify({ kind: "event_detail", meta: {} }),
  };
  const map = buildLacotorraDetailMap([older, VR_DETAIL_ROW, stub, ...CHROME_ROWS]);
  assert.equal(map.size, 1, "only the real detail row indexed (stub + chrome skipped)");
  const info = map.get(VR_DETAIL_URL);
  assert.ok(info.fullText.startsWith("С 20 июля по 31 августа 2026 года"), "freshest text wins");
  assert.equal(info.image, "https://lacotorra.io/uploads/afisha/A_VR_exhibition_eclipse_Valencia.jpg");
});

// The REAL VR block exactly as it sits in live snapshot id 2137 (lines 234–238)
// plus the REAL captured event_link for it.
const VR_SNAPSHOT_ROW = {
  id: 2137,
  source_key: LACOTORRA_SOURCE_KEY,
  title: "Мероприятия Валенсии. Афиша для всей семьи.",
  url: "https://lacotorra.io/events",
  raw_text: [
    "VR-выставка о затмении в Валенсии",
    "Валенсия",
    "Выставка совмещает VR и ИИ, вход свободный...",
    "20 Jul 2026, 10:00 - 31 Aug 2026, 00:00",
    "Centro de Innovación Social y Urbana Las Naves",
  ].join("\n"),
  raw_json: JSON.stringify({
    kind: "page_snapshot",
    meta: { "og:image": "https://lacotorra.io/uploads/OG-image.png" },
    event_links: [
      { title: "VR-выставка о затмении в Валенсии", url: VR_DETAIL_URL },
    ],
  }),
};

test("buildLacotorraEvents (T201): detail full text preferred over the index teaser", () => {
  const details = buildLacotorraDetailMap([VR_DETAIL_ROW]);
  const events = buildLacotorraEvents([VR_SNAPSHOT_ROW], REF, details);
  assert.equal(events.length, 1);
  const vr = events[0].draft;
  assert.equal(vr.title, "VR-выставка о затмении в Валенсии");
  // Description is the FULL article (not the "…"-cut 45-char teaser).
  assert.ok(vr.description.startsWith("С 20 июля по 31 августа 2026 года"), "full text used");
  assert.ok(vr.description.length > 400, `full text length (got ${vr.description.length})`);
  assert.ok(!vr.description.endsWith("..."), "not the truncated teaser");
  // The teaser remains as the raw index excerpt.
  assert.equal(vr.raw_excerpt, "Выставка совмещает VR и ИИ, вход свободный...");
  // Event-specific image beats the index's generic OG banner.
  assert.equal(vr.image_url, "https://lacotorra.io/uploads/afisha/A_VR_exhibition_eclipse_Valencia.jpg");
  // T190 URL wiring untouched.
  assert.equal(vr.url, VR_DETAIL_URL);
  assert.equal(vr.source_url, VR_DETAIL_URL);
  // Date parsing untouched (multi-day → time dropped per Bug 3).
  assert.equal(vr.start_date, "2026-07-20");
  assert.equal(vr.end_date, "2026-08-31");
  assert.equal(vr.start_time, null);
});

test("buildLacotorraEvents (T201): no detail row → index teaser kept (graceful fallback)", () => {
  // No details map at all (legacy call) AND an empty map: both keep the teaser.
  for (const details of [undefined, new Map()]) {
    const events = buildLacotorraEvents([VR_SNAPSHOT_ROW], REF, details);
    assert.equal(events.length, 1);
    const vr = events[0].draft;
    assert.equal(vr.description, "Выставка совмещает VR и ИИ, вход свободный...");
    assert.equal(vr.image_url, "https://lacotorra.io/uploads/OG-image.png");
  }
});

test("normalizeLacotorra: idempotent over injected exec, marks every row normalized", async () => {
  // Minimal fake exec: SELECT returns the pending rows; INSERT reports inserted;
  // UPDATE (markRawItem) is recorded. Verifies fail-soft wiring + bookkeeping.
  const pending = [SNAPSHOT_ROW, ...CHROME_ROWS];
  const marked = new Set();
  let inserts = 0;

  const exec = async (strings) => {
    const q = strings.join(" ");
    if (/SELECT \* FROM source_items/i.test(q)) return pending;
    if (/INSERT INTO events/i.test(q)) {
      inserts++;
      return [{ inserted: true }];
    }
    if (/UPDATE source_items/i.test(q)) {
      // last interpolated value is the id; capture from the tagged-call args below
      return [];
    }
    return [];
  };
  // Wrap so we can capture the id passed to markRawItem UPDATEs.
  const tracking = (strings, ...vals) => {
    const q = strings.join(" ");
    if (/UPDATE source_items/i.test(q)) marked.add(vals[vals.length - 1]);
    return exec(strings, ...vals);
  };

  const res = await normalizeLacotorra({ exec: tracking });
  assert.equal(res.processed, pending.length);
  assert.equal(res.created, 4); // 4 events upserted
  assert.equal(inserts, 4);
  // Every raw row (snapshot + all chrome) marked normalized — append-only.
  for (const r of pending) assert.ok(marked.has(r.id), `row ${r.id} marked`);
});

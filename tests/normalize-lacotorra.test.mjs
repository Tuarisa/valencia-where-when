import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LACOTORRA_SOURCE_KEY,
  parseLacotorraDate,
  buildLacotorraEvents,
  normalizeLacotorra,
} from "../lib/pipeline/normalizers/lacotorra.ts";

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
  // Madrid block — WITH city line
  "Выставка с редкими работами Сальвадора Дали в Мадриде",
  "Мадрид",
  "Скульптуры известного художника хранились в частных коллекциях десятки лет...",
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

test("parseLacotorraDate: range → start/end ISO + start time", () => {
  const r = parseLacotorraDate("9 Jun 2026, 10:00 - 5 Aug 2026, 12:00");
  assert.equal(r.start, "2026-06-09");
  assert.equal(r.end, "2026-08-05");
  assert.equal(r.startTime, "10:00");
});

test("parseLacotorraDate: single day → start only, null end", () => {
  const r = parseLacotorraDate("7 Jul 2026, 22:00");
  assert.equal(r.start, "2026-07-07");
  assert.equal(r.end, null);
  assert.equal(r.startTime, "22:00");
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
  assert.equal(pupae.start_time, "10:00");
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

  // Madrid block: city mapped from the RU city line.
  const dali = byTitle["Выставка с редкими работами Сальвадора Дали в Мадриде"];
  assert.ok(dali, "Dali event present");
  assert.equal(dali.city, "Madrid");
  assert.equal(dali.start_date, "2026-03-26");
  assert.equal(dali.venue_name, "Palacio de Gaviria");

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
    "Выставка с редкими работами Сальвадора Дали в Мадриде",
    "Мадрид",
    "Скульптуры известного художника...",
    "26 Mar 2026, 12:00 - 31 Dec 2026, 12:00",
    "Palacio de Gaviria",
    "Концерт с музыкой из сериала «Бриджертоны» в Мадриде",
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

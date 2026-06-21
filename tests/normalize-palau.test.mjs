import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PALAU_SOURCE_KEY,
  isPalauEventUrl,
  parsePalauDate,
  deTriplicate,
  palauTitle,
  buildPalauEvents,
  normalizePalau,
} from "../lib/pipeline/normalizers/palau.ts";

// Fixtures FAITHFUL to the live web:palau rows (verified read-only against the local
// DB). Real events are `/event?id=NNNN&mod=<unixts>` link_cards whose raw_text is a
// flattened TRILINGUAL card: "Data: Fecha: Date: DD/MM/YYYY Hora: Time: HH:MM
// <title_ca> <title_es> <title_en>". Nav/chrome rows are category anchors (url ends
// with `#`) and institutional pages whose text is just a label, no date.
const FIXED_TODAY = new Date("2026-06-21T00:00:00Z");

// title identical across all three languages → repeated verbatim 3×
const evEnescu = {
  id: 542,
  source_key: "web:palau",
  item_type: "mixed",
  title: "Data: Fecha: Date: 25/06/2026 Hora: Time: 18:00 Enescu 70 Enescu 70 Enescu 70",
  url: "https://palauvalencia.com/event?id=2735&mod=1781868099",
  raw_text: "Data: Fecha: Date: 25/06/2026 Hora: Time: 18:00 Enescu 70 Enescu 70 Enescu 70",
  raw_json: '{"kind":"link_card","source_page":"https://palauvalencia.com/programacio-i-vendes/"}',
};

const evJazz = {
  id: 543,
  source_key: "web:palau",
  item_type: "mixed",
  title:
    "Data: Fecha: Date: 04/07/2026 Hora: Time: 19:00 29 Festival de Jazz de València LIZZ WRIGHT 29 Festival de Jazz de València LIZZ WRIGHT 29 Festival de Jazz de València LIZZ WRIGHT",
  url: "https://palauvalencia.com/event?id=2617&mod=1779443345",
  raw_text:
    "Data: Fecha: Date: 04/07/2026 Hora: Time: 19:00 29 Festival de Jazz de València LIZZ WRIGHT 29 Festival de Jazz de València LIZZ WRIGHT 29 Festival de Jazz de València LIZZ WRIGHT",
  raw_json: '{"kind":"link_card","source_page":"https://palauvalencia.com/programacio-i-vendes/"}',
};

// title differs by a connective across CA/ES/EN ("i" / "y" / "and")
const evIterum = {
  id: 547,
  source_key: "web:palau",
  item_type: "mixed",
  title:
    "Data: Fecha: Date: 13/09/2026 Hora: Time: 19:00 ÍTERUM: Nostrum Mare Camerata i Jacobo Christensen ÍTERUM: Nostrum Mare Camerata y Jacobo Christensen ÍTERUM: Nostrum Mare Camerata and Jacobo Christensen",
  url: "https://palauvalencia.com/event?id=2604&mod=1777896131",
  raw_text:
    "Data: Fecha: Date: 13/09/2026 Hora: Time: 19:00 ÍTERUM: Nostrum Mare Camerata i Jacobo Christensen ÍTERUM: Nostrum Mare Camerata y Jacobo Christensen ÍTERUM: Nostrum Mare Camerata and Jacobo Christensen",
  raw_json: '{"kind":"link_card","source_page":"https://palauvalencia.com/programacio-i-vendes/"}',
};

// nav/chrome rows that must be DROPPED
const navCategory = {
  id: 530,
  source_key: "web:palau",
  item_type: "mixed",
  title: "29 Festival de Jazz de València",
  url: "https://palauvalencia.com/programacio-i-vendes/#",
  raw_text: "29 Festival de Jazz de València",
  raw_json: '{"kind":"link_card","source_page":"https://palauvalencia.com/programacio-i-vendes/"}',
};

const navLegal = {
  id: 560,
  source_key: "web:palau",
  item_type: "mixed",
  title: "Avís legal",
  url: "https://palauvalencia.com/avis-legal",
  raw_text: "Avís legal",
  raw_json: '{"kind":"link_card","source_page":"https://palauvalencia.com/programacio-i-vendes/"}',
};

const snapshot = {
  id: 525,
  source_key: "web:palau",
  item_type: "snapshot",
  title: "Programació i vendes – Palau",
  url: "https://palauvalencia.com/programacio-i-vendes/",
  raw_text: "Programació i vendes – Palau Skip to content Programació i vendes …",
  raw_json: '{"kind":"page_snapshot","meta":{"title":"Programació i vendes – Palau"}}',
};

test("PALAU_SOURCE_KEY matches sources.json", () => {
  assert.equal(PALAU_SOURCE_KEY, "web:palau");
});

test("isPalauEventUrl keeps /event?id= and drops nav/category/institutional", () => {
  assert.equal(isPalauEventUrl("https://palauvalencia.com/event?id=2735&mod=1781868099"), true);
  assert.equal(isPalauEventUrl("https://palauvalencia.com/programacio-i-vendes/#"), false);
  assert.equal(isPalauEventUrl("https://palauvalencia.com/avis-legal"), false);
  assert.equal(isPalauEventUrl("https://palauvalencia.com/historia-del-palau/"), false);
  assert.equal(isPalauEventUrl(null), false);
});

test("parsePalauDate parses DD/MM/YYYY (day-first) into ISO", () => {
  assert.equal(parsePalauDate("25/06/2026"), "2026-06-25");
  assert.equal(parsePalauDate("04/07/2026"), "2026-07-04");
  assert.equal(parsePalauDate("23/12/2026"), "2026-12-23");
  // 2-digit year support + implausible guard
  assert.equal(parsePalauDate("01/01/26"), "2026-01-01");
  assert.equal(parsePalauDate("40/13/2026"), null);
  assert.equal(parsePalauDate(null), null);
});

test("deTriplicate collapses identical CA/ES/EN repeats to one", () => {
  assert.equal(deTriplicate("Enescu 70 Enescu 70 Enescu 70"), "Enescu 70");
  assert.equal(
    deTriplicate(
      "29 Festival de Jazz de València LIZZ WRIGHT 29 Festival de Jazz de València LIZZ WRIGHT 29 Festival de Jazz de València LIZZ WRIGHT",
    ),
    "29 Festival de Jazz de València LIZZ WRIGHT",
  );
});

test("deTriplicate keeps the Catalan first third when CA/ES/EN diverge by a connective", () => {
  const t = deTriplicate(
    "ÍTERUM: Nostrum Mare Camerata i Jacobo Christensen ÍTERUM: Nostrum Mare Camerata y Jacobo Christensen ÍTERUM: Nostrum Mare Camerata and Jacobo Christensen",
  );
  assert.equal(t, "ÍTERUM: Nostrum Mare Camerata i Jacobo Christensen");
});

test("palauTitle strips the Data/Hora header and de-triplicates", () => {
  assert.equal(palauTitle(evEnescu.raw_text), "Enescu 70");
  assert.equal(palauTitle(evJazz.raw_text), "29 Festival de Jazz de València LIZZ WRIGHT");
});

test("buildPalauEvents: events parsed, junk dropped", () => {
  const rows = [snapshot, navCategory, navLegal, evEnescu, evJazz, evIterum];
  const out = buildPalauEvents(rows, FIXED_TODAY);
  // only the 3 real /event?id= rows survive
  assert.equal(out.length, 3);

  const byId = new Map(out.map((o) => [o.sourceItemId, o.draft]));
  const enescu = byId.get(542);
  assert.ok(enescu, "Enescu event present");
  assert.equal(enescu.title, "Enescu 70");
  assert.equal(enescu.start_date, "2026-06-25");
  assert.equal(enescu.start_time, "18:00");
  assert.equal(enescu.venue_name, "Palau de la Música");
  assert.equal(enescu.city, "Valencia");
  assert.equal(enescu.country, "Spain");
  assert.equal(enescu.source, "web:palau");
  assert.equal(enescu.source_url, "https://palauvalencia.com/event?id=2735&mod=1781868099");

  const jazz = byId.get(543);
  assert.equal(jazz.title, "29 Festival de Jazz de València LIZZ WRIGHT");
  assert.equal(jazz.start_date, "2026-07-04");
  assert.equal(jazz.start_time, "19:00");

  // nav/chrome + snapshot produced NO events
  assert.equal(byId.has(530), false);
  assert.equal(byId.has(560), false);
  assert.equal(byId.has(525), false);
});

test("normalizePalau upserts events and marks EVERY raw row normalized (append-only)", async () => {
  const rows = [snapshot, navCategory, navLegal, evEnescu, evJazz, evIterum];
  const inserted = [];
  const marked = [];

  // Minimal fake tagged-template `exec` that recognises the queries this normalizer
  // issues: the pending SELECT, the events upsert, and the markRawItem UPDATE.
  const exec = async (strings, ...values) => {
    const q = strings.join("?");
    if (/SELECT \* FROM source_items/i.test(q)) return rows;
    if (/INSERT INTO events/i.test(q)) {
      inserted.push(values);
      return [{ inserted: true }];
    }
    if (/UPDATE source_items/i.test(q)) {
      // last value bound is the row id
      marked.push(values[values.length - 1]);
      return [];
    }
    return [];
  };

  const res = await normalizePalau({ exec });
  assert.equal(res.processed, rows.length); // all 6 rows processed
  assert.equal(res.created, 3); // 3 real events created
  assert.equal(inserted.length, 3);
  // append-only: EVERY raw row marked normalized, incl. dropped nav/snapshot
  assert.equal(marked.length, rows.length);
  for (const r of rows) assert.ok(marked.includes(r.id), `row ${r.id} marked`);
});

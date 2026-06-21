import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TICKETMASTER_SOURCE_KEY,
  isTicketmasterEventUrl,
  parseTicketmasterTime,
  splitTicketmasterVenue,
  parseTicketmasterHead,
  buildTicketmasterEvents,
  normalizeTicketmaster,
} from "../lib/pipeline/normalizers/ticketmaster.ts";

const TODAY = new Date("2026-06-21");

// Fixtures faithful to the REAL live `source_items` rows for web:ticketmaster
// (item_type 'mixed', raw_json kind 'link_card', the flattened card in title).
function card(id, title, url) {
  return {
    id,
    source_key: TICKETMASTER_SOURCE_KEY,
    item_type: "mixed",
    title,
    url,
    raw_text: title,
    raw_json: JSON.stringify({
      kind: "link_card",
      source_page: "https://www.ticketmaster.es/discover/valencia",
    }),
    last_seen: "2026-06-20T00:00:00Z",
  };
}

const FULL_SPANISH = card(
  659,
  "domingo, 6 de septiembre de 2026, 20:30 dom 6 sept 20:30 RAWAYANA - ¿Dónde Es El After? World Tour Roig Arena",
  "https://www.ticketmaster.es/event/rawayana-donde-es-el-after-world-tour-entradas/21207859",
);
const FULL_SPANISH_2027 = card(
  664,
  "viernes, 9 de abril de 2027, 20:30 vie 9 abr 2027 20:30 Thirty Seconds to Mars Presents A Beautiful Lie vs This Is War Roig Arena",
  "https://www.ticketmaster.es/event/thirty-seconds-to-mars-presents-a-beautiful-lie-vs-this-is-war-entradas/1354406695",
);
const ENTRADAS = card(
  675,
  "Entradas Carlos Rivera, Valencia Plaza de Toros de Valencia 27/6/26, 21:00",
  "https://www.ticketmaster.es/event/carlos-rivera-entradas/1488571113",
);
const ENTRADAS_MIDNIGHT = card(
  693,
  "Entradas Transvision Vamp, Valencia Sala Moon 3/10/26, 0:00",
  "https://www.ticketmaster.es/event/transvision-vamp-entradas/212779377",
);

// Junk / non-event rows that MUST be dropped.
const SNAPSHOT = {
  id: 650,
  source_key: TICKETMASTER_SOURCE_KEY,
  item_type: "snapshot",
  title: "Eventos en Valencia | Ticketmaster",
  url: "https://www.ticketmaster.es/discover/valencia",
  raw_text: "Eventos en Valencia ... ",
  raw_json: JSON.stringify({ kind: "page_snapshot", meta: {} }),
};
const NAV = card(
  657,
  "Todas las categorías",
  "https://www.ticketmaster.es/discover/valencia",
);
const ARTIST = card(
  654,
  "Latin Pop La Reina del Flow 8 jul 2026",
  "https://www.ticketmaster.es/artist/la-reina-del-flow-entradas/1468143",
);
const VENUE = card(
  668,
  "Conciertos Roig Arena C/ del Bomber Ramon Duart, 12, 46013 Valencia, España",
  "https://www.ticketmaster.es/venue/roig-arena-valencia-entradas/roigareval/112",
);
const BLOG = card(
  701,
  "Próximos conciertos en Valencia Aquí tienes una guia con los mejores conciertos",
  "https://blog.ticketmaster.es/post/proximos-conciertos-en-valencia-33525/",
);

test("source key matches sources.json (web:ticketmaster)", () => {
  assert.equal(TICKETMASTER_SOURCE_KEY, "web:ticketmaster");
});

test("isTicketmasterEventUrl keeps /event/ only", () => {
  assert.equal(isTicketmasterEventUrl(FULL_SPANISH.url), true);
  assert.equal(isTicketmasterEventUrl(ENTRADAS.url), true);
  assert.equal(isTicketmasterEventUrl(ARTIST.url), false);
  assert.equal(isTicketmasterEventUrl(VENUE.url), false);
  assert.equal(isTicketmasterEventUrl(NAV.url), false);
  assert.equal(isTicketmasterEventUrl(null), false);
});

test("parseTicketmasterTime reads first HH:MM, zero-pads, validates", () => {
  assert.equal(parseTicketmasterTime("… 27/6/26, 21:00"), "21:00");
  assert.equal(parseTicketmasterTime("… 3/10/26, 0:00"), "00:00");
  assert.equal(parseTicketmasterTime("no time here"), null);
  assert.equal(parseTicketmasterTime("99:99"), null);
});

test("splitTicketmasterVenue splits a known venue off the tail", () => {
  assert.deepEqual(
    splitTicketmasterVenue("RAWAYANA - ¿Dónde Es El After? World Tour Roig Arena"),
    { title: "RAWAYANA - ¿Dónde Es El After? World Tour", venue: "Roig Arena" },
  );
  // longest-first: "Auditorio Roig Arena" must win over "Roig Arena"
  assert.deepEqual(
    splitTicketmasterVenue("Raul Clyde Auditorio Roig Arena"),
    { title: "Raul Clyde", venue: "Auditorio Roig Arena" },
  );
  // unknown venue → whole head is the title, venue null
  assert.deepEqual(
    splitTicketmasterVenue("Some Act At Mystery Hall"),
    { title: "Some Act At Mystery Hall", venue: null },
  );
});

test("parseTicketmasterHead — Entradas form: title + venue", () => {
  assert.deepEqual(parseTicketmasterHead(ENTRADAS.title), {
    title: "Carlos Rivera",
    venue: "Plaza de Toros de Valencia",
  });
  assert.deepEqual(parseTicketmasterHead(ENTRADAS_MIDNIGHT.title), {
    title: "Transvision Vamp",
    venue: "Sala Moon",
  });
});

test("parseTicketmasterHead — full-Spanish form: strips preamble, splits venue", () => {
  assert.deepEqual(parseTicketmasterHead(FULL_SPANISH.title), {
    title: "RAWAYANA - ¿Dónde Es El After? World Tour",
    venue: "Roig Arena",
  });
  assert.deepEqual(parseTicketmasterHead(FULL_SPANISH_2027.title), {
    title: "Thirty Seconds to Mars Presents A Beautiful Lie vs This Is War",
    venue: "Roig Arena",
  });
});

test("buildTicketmasterEvents — full-Spanish row → dated event", () => {
  const out = buildTicketmasterEvents([FULL_SPANISH], TODAY);
  assert.equal(out.length, 1);
  const d = out[0].draft;
  assert.equal(d.title, "RAWAYANA - ¿Dónde Es El After? World Tour");
  assert.equal(d.start_date, "2026-09-06");
  assert.equal(d.start_time, "20:30");
  assert.equal(d.venue_name, "Roig Arena");
  assert.equal(d.city, "Valencia");
  assert.equal(d.country, "Spain");
  assert.equal(d.source, "web:ticketmaster");
  assert.equal(d.url, FULL_SPANISH.url);
});

test("buildTicketmasterEvents — Entradas row → dated event (DD/M/YY)", () => {
  const out = buildTicketmasterEvents([ENTRADAS], TODAY);
  assert.equal(out.length, 1);
  const d = out[0].draft;
  assert.equal(d.title, "Carlos Rivera");
  assert.equal(d.start_date, "2026-06-27");
  assert.equal(d.start_time, "21:00");
  assert.equal(d.venue_name, "Plaza de Toros de Valencia");
});

test("buildTicketmasterEvents — next-year 2027 date is preserved literally", () => {
  const out = buildTicketmasterEvents([FULL_SPANISH_2027], TODAY);
  assert.equal(out[0].draft.start_date, "2027-04-09");
});

test("buildTicketmasterEvents — drops snapshot / nav / artist / venue / blog rows", () => {
  const out = buildTicketmasterEvents(
    [SNAPSHOT, NAV, ARTIST, VENUE, BLOG, FULL_SPANISH, ENTRADAS],
    TODAY,
  );
  // only the two /event/ rows survive
  assert.equal(out.length, 2);
  const ids = out.map((o) => o.sourceItemId).sort();
  assert.deepEqual(ids, [659, 675]);
});

// Injectable-exec test: normalizeTicketmaster marks EVERY processed row normalized
// (append-only) — including the dropped non-event rows — and upserts the events.
test("normalizeTicketmaster — fake exec: upserts events, marks ALL rows normalized", async () => {
  const all = [SNAPSHOT, NAV, ARTIST, VENUE, FULL_SPANISH, ENTRADAS];
  const inserts = [];
  const marked = [];

  const exec = async (strings, ...vals) => {
    const q = strings.join("?");
    if (/SELECT \* FROM source_items/.test(q)) return all;
    if (/INSERT INTO events/.test(q)) {
      inserts.push(vals);
      return [{ inserted: true }];
    }
    if (/UPDATE source_items/.test(q)) {
      // last bound value is the row id
      marked.push(vals[vals.length - 1]);
      return [];
    }
    return [];
  };

  const res = await normalizeTicketmaster({ exec });
  assert.equal(res.processed, all.length);
  assert.equal(res.created, 2); // two /event/ rows
  assert.equal(res.updated, 0);
  // append-only: EVERY raw row marked normalized, dropped ones included
  assert.equal(marked.length, all.length);
  assert.deepEqual(
    marked.slice().sort((a, b) => a - b),
    all.map((r) => r.id).sort((a, b) => a - b),
  );
});

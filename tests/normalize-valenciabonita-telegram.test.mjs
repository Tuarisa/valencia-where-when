import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildValenciabonitaTgEvents,
  deriveCategory,
  detectLang,
  VALENCIABONITA_TG_SOURCE_KEY,
} from "../lib/pipeline/normalizers/valenciabonita-telegram.ts";
import {
  parseRelativeEsDate,
  postDateOf,
} from "../lib/pipeline/normalizers/shared.ts";

// FR-001 — Valencia Bonita normalizer (telegram tg:valenciabonitatelegram, a
// Valencia-local ES culture/events channel: city festivals, fiestas, weekend plans).
// These tests exercise the PURE buildValenciabonitaTgEvents (no DB): event keep/drop,
// the draft shape (Valencia/Spain default, parsed date, derived category, detected
// language), and idempotency. Fixtures mirror parseTelegram's raw row:
// `raw_json = { kind: "telegram_post", post_ref, media_urls }`, the post body in
// `raw_text`, the first line as `title`, the t.me link as `url`. Like vidacultural,
// this is a local channel — NO Spain pre-filter.

const TODAY = new Date("2026-06-01T00:00:00Z");

// Build a synthetic telegram RawItem faithful to ingest.parseTelegram.
function tgItem(id, channel, postId, body, media = [], publishedAt = null) {
  const title = body.split("\n", 1)[0];
  return {
    id,
    source_key: VALENCIABONITA_TG_SOURCE_KEY,
    item_type: "mixed",
    external_id: `${channel}/${postId}`,
    title: title.slice(0, 200),
    url: `https://t.me/${channel}/${postId}`,
    published_at: publishedAt,
    raw_text: body,
    raw_html: null,
    raw_json: JSON.stringify({
      kind: "telegram_post",
      post_ref: `${channel}/${postId}`,
      media_urls: media,
    }),
    last_seen: "2026-06-01T00:00:00Z",
  };
}

test("event-like ES fiesta post is KEPT with Valencia/Spain + parsed date + category", () => {
  const rows = [
    tgItem(
      1,
      "valenciabonitatelegram",
      "100",
      "Gran Feria de Julio en Valencia\n21 de junio de 2026\nJardines de Viveros\nEntrada libre",
      ["https://cdn.tg/feria.jpg"],
    ),
  ];
  const out = buildValenciabonitaTgEvents(rows, TODAY);
  assert.equal(out.length, 1, "fiesta post should be kept");
  const { draft, sourceItemId } = out[0];
  assert.equal(sourceItemId, 1);
  assert.equal(draft.city, "Valencia");
  assert.equal(draft.country, "Spain");
  assert.equal(draft.start_date, "2026-06-21");
  assert.equal(draft.category, "festival");
  assert.equal(draft.language, "es");
  assert.equal(draft.source, VALENCIABONITA_TG_SOURCE_KEY);
  assert.equal(draft.url, "https://t.me/valenciabonitatelegram/100");
  assert.equal(draft.image_url, "https://cdn.tg/feria.jpg");
  assert.ok(draft.title && draft.title.length > 0, "title is non-empty");
});

test("non-event chatter post (looksLikeEvent false) is DROPPED", () => {
  const rows = [
    // too short / no date / no venue cue — pure chatter
    tgItem(2, "valenciabonitatelegram", "101", "¡Buenos días! 😊"),
    tgItem(3, "valenciabonitatelegram", "102", "Gracias a todos por seguirnos"),
  ];
  const out = buildValenciabonitaTgEvents(rows, TODAY);
  assert.equal(out.length, 0, "chatter posts should all be dropped");
});

test("idempotency: same input twice yields identical drafts", () => {
  const rows = [
    tgItem(
      1,
      "valenciabonitatelegram",
      "100",
      "Gran Feria de Julio en Valencia\n21 de junio de 2026\nJardines de Viveros\nEntrada libre",
      ["https://cdn.tg/feria.jpg"],
    ),
    tgItem(
      4,
      "valenciabonitatelegram",
      "103",
      "Concierto en el Palau\n15 de julio de 2026\nPalau de la Música\n25 €",
    ),
  ];
  const a = buildValenciabonitaTgEvents(rows, TODAY);
  const b = buildValenciabonitaTgEvents(rows, TODAY);
  assert.deepEqual(a, b, "buildValenciabonitaTgEvents is deterministic");
});

test("source key matches sources.json exactly", () => {
  assert.equal(VALENCIABONITA_TG_SOURCE_KEY, "tg:valenciabonitatelegram");
});

test("deriveCategory recognises cues, defaults to event", () => {
  assert.equal(deriveCategory("Feria de Julio"), "festival");
  assert.equal(deriveCategory("Concierto de jazz"), "concert");
  assert.equal(deriveCategory("Exposición de fotografía"), "exhibition");
  assert.equal(deriveCategory("Teatro de danza"), "theatre");
  assert.equal(deriveCategory("Taller infantil de pintura"), "family");
  assert.equal(deriveCategory("Algo sin pistas claras"), "event");
});

test("detectLang defaults to es, flips to ru on Cyrillic-dominant body", () => {
  assert.equal(detectLang("Gran fiesta en Valencia este fin de semana"), "es");
  assert.equal(detectLang("Большой концерт в Валенсии в эти выходные"), "ru");
  // a few stray Cyrillic chars in a Spanish post stays es
  assert.equal(detectLang("Concierto en Valencia (концерт)"), "es");
});

// --- T152: relative ES dates anchored to the POST date (never normalize-time now) ---
// 2026-06: Mon 15 … Sun 21 is one week (Sat 20 / Sun 21); Sat 27 / Sun 28 the next.

test("parseRelativeEsDate: 'este fin de semana' mid-week → that week's Sat..Sun", () => {
  const wed = new Date(2026, 5, 17); // Wednesday
  assert.deepEqual(
    parseRelativeEsDate("Planes para este fin de semana en Valencia", wed),
    { start: "2026-06-20", end: "2026-06-21" },
  );
  assert.deepEqual(parseRelativeEsDate("¿Qué hacer este finde?", wed), {
    start: "2026-06-20",
    end: "2026-06-21",
  });
});

test("parseRelativeEsDate: weekend on Saturday itself / on Sunday (in-progress weekend)", () => {
  assert.deepEqual(parseRelativeEsDate("este fin de semana", new Date(2026, 5, 20)), {
    start: "2026-06-20",
    end: "2026-06-21",
  });
  // Sunday post: the weekend is in progress — its Saturday was yesterday.
  assert.deepEqual(parseRelativeEsDate("este fin de semana", new Date(2026, 5, 21)), {
    start: "2026-06-20",
    end: "2026-06-21",
  });
});

test("parseRelativeEsDate: 'próximo fin de semana' → the following week's Sat..Sun", () => {
  assert.deepEqual(
    parseRelativeEsDate("el próximo fin de semana", new Date(2026, 5, 17)),
    { start: "2026-06-27", end: "2026-06-28" },
  );
});

test("parseRelativeEsDate: 'este mes' near month end → post day .. last day of month", () => {
  assert.deepEqual(parseRelativeEsDate("Agenda de este mes", new Date(2026, 5, 28)), {
    start: "2026-06-28",
    end: "2026-06-30",
  });
});

test("parseRelativeEsDate: hoy / mañana; 'por la mañana' is morning, not tomorrow", () => {
  const wed = new Date(2026, 5, 17);
  assert.deepEqual(parseRelativeEsDate("hoy concierto en el jardín", wed), {
    start: "2026-06-17",
    end: null,
  });
  assert.deepEqual(parseRelativeEsDate("Mañana gran fiesta", wed), {
    start: "2026-06-18",
    end: null,
  });
  assert.equal(parseRelativeEsDate("concierto el domingo por la mañana", wed), null);
});

test("parseRelativeEsDate: WITHOUT a post date → null (never anchored to run-time now)", () => {
  assert.equal(parseRelativeEsDate("este fin de semana", null), null);
  assert.equal(parseRelativeEsDate("este mes", undefined), null);
});

test("postDateOf prefers published_at, falls back to scrape timestamps, else null", () => {
  assert.deepEqual(
    postDateOf({ published_at: "2026-06-17T18:03:00+00:00", last_seen: "2026-06-19T00:00:00Z" }),
    new Date(2026, 5, 17),
  );
  assert.deepEqual(
    postDateOf({ published_at: null, last_seen: "2026-06-19T00:00:00Z" }),
    new Date(2026, 5, 19),
  );
  assert.equal(postDateOf({ published_at: null, last_seen: null }), null);
  assert.equal(postDateOf(null), null);
});

test("build: 'este fin de semana' post resolves against published_at (T152)", () => {
  const rows = [
    tgItem(
      6,
      "valenciabonitatelegram",
      "105",
      "Mercado medieval este fin de semana\nPlaza del Ayuntamiento\nEntrada libre",
      [],
      "2026-06-17T10:00:00+00:00", // Wednesday
    ),
  ];
  const out = buildValenciabonitaTgEvents(rows, TODAY);
  assert.equal(out.length, 1, "relative-dated post is kept");
  assert.equal(out[0].draft.start_date, "2026-06-20");
  assert.equal(out[0].draft.end_date, "2026-06-21");
});

test("build: 'este mes' near month end → window from POST day to month end", () => {
  const rows = [
    tgItem(
      7,
      "valenciabonitatelegram",
      "106",
      "Agenda cultural de este mes\nMuseo de Bellas Artes",
      [],
      "2026-06-28T09:00:00+00:00",
    ),
  ];
  const out = buildValenciabonitaTgEvents(rows, TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, "2026-06-28");
  assert.equal(out[0].draft.end_date, "2026-06-30");
});

test("build: relative phrase WITHOUT any post date emits NO date (post dropped)", () => {
  const item = tgItem(
    8,
    "valenciabonitatelegram",
    "107",
    "Gran fiesta este fin de semana con muchas sorpresas",
  );
  item.published_at = null;
  item.last_seen = null; // no post date, no scrape date → nothing to anchor to
  const out = buildValenciabonitaTgEvents([item], TODAY);
  assert.equal(out.length, 0, "no anchor → no date → no venue cue → dropped");
});

test("build: same relative post WITH published_at is kept, dated to the post's weekend", () => {
  const item = tgItem(
    9,
    "valenciabonitatelegram",
    "108",
    "Gran fiesta este fin de semana con muchas sorpresas",
    [],
    "2026-06-17T10:00:00+00:00",
  );
  item.last_seen = null; // isolate: the anchor is published_at alone
  const out = buildValenciabonitaTgEvents([item], TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, "2026-06-20");
  assert.equal(out[0].draft.end_date, "2026-06-21");
});

test("build: an explicit date in the body beats the relative phrase", () => {
  const rows = [
    tgItem(
      10,
      "valenciabonitatelegram",
      "109",
      "Concierto este fin de semana\n21 de junio de 2026\nPalau de la Música",
      [],
      "2026-06-17T10:00:00+00:00",
    ),
  ];
  const out = buildValenciabonitaTgEvents(rows, TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, "2026-06-21", "explicit date wins");
  assert.equal(out[0].draft.end_date, null, "no relative window when explicit date used");
});

test("RU-language event post is KEPT and tagged ru", () => {
  const rows = [
    tgItem(
      5,
      "valenciabonitatelegram",
      "104",
      "Большой концерт в Валенсии\n21 июня 2026\nДворец музыки\nвход свободный",
    ),
  ];
  const out = buildValenciabonitaTgEvents(rows, TODAY);
  assert.equal(out.length, 1, "ru event post should be kept");
  assert.equal(out[0].draft.language, "ru");
  assert.equal(out[0].draft.start_date, "2026-06-21");
});

// ---------------------------------------------------------------------------
// T209 (T207 sibling) — the explicit-date branch is year-anchored to the POST
// date, with the roll-forward guard. Fixture is the VERBATIM live digest row
// (source_items 1047) whose «desde el pasado 22 de junio» — a PAST date at post
// time — rolled to 2027-06-22 (orphan event 26129).
// ---------------------------------------------------------------------------

const SAN_JUAN_DIGEST =
  'Hola amig@s. Feliz miércoles, día de San Juan. Os traemos las novedades que hemos publicado. ⛔️ El Ayuntamiento limita el acceso desde el pasado 22 de junio al rincón natural yatovense para preservarlo del incivismo y los actos vandálicos de las últimas visitas. Más información en https://wp.me/p6uTWT-TVm 👈';

test("T209: a digest's just-passed «22 de junio» (published 2026-06-24) keeps the post's own year — no roll to 2027", () => {
  const rows = [
    tgItem(1047, "valenciabonitatelegram", "4213", SAN_JUAN_DIGEST, [], "2026-06-24T11:24:29+00:00"),
  ];
  // 2026-06-24T21:33 = the live first-normalize moment that fabricated 2027-06-22.
  const out = buildValenciabonitaTgEvents(rows, new Date("2026-06-24T21:33:48Z"));
  assert.equal(out.length, 1, "digest post with a date is kept");
  assert.equal(out[0].draft.start_date, "2026-06-22", "history, not next year");
});

test("T209: stable across normalize times — same digest post, same draft weeks later", () => {
  const rows = [
    tgItem(1047, "valenciabonitatelegram", "4213", SAN_JUAN_DIGEST, [], "2026-06-24T11:24:29+00:00"),
  ];
  const before = buildValenciabonitaTgEvents(rows, new Date("2026-06-24T21:33:48Z"));
  const after = buildValenciabonitaTgEvents(rows, new Date("2026-08-07T21:43:34Z"));
  assert.deepEqual(before, after, "normalize time must not change the draft (hash stability)");
  assert.equal(before[0].draft.start_date, "2026-06-22");
});

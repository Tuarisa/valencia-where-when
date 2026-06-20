import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildValenciabonitaTgEvents,
  deriveCategory,
  detectLang,
  VALENCIABONITA_TG_SOURCE_KEY,
} from "../lib/pipeline/normalizers/valenciabonita-telegram.ts";

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
function tgItem(id, channel, postId, body, media = []) {
  const title = body.split("\n", 1)[0];
  return {
    id,
    source_key: VALENCIABONITA_TG_SOURCE_KEY,
    item_type: "mixed",
    external_id: `${channel}/${postId}`,
    title: title.slice(0, 200),
    url: `https://t.me/${channel}/${postId}`,
    published_at: null,
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

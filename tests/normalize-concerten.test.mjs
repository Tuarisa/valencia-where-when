import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConcertenEvents,
  spainCity,
  CONCERTEN_SOURCE_KEY,
} from "../lib/pipeline/normalizers/concerten.ts";

// T112 — concerten normalizer (telegram tg:concerten, "Зарубежная афиша" RU-artist
// tours across ALL of Europe). These tests exercise the PURE buildConcertenEvents (no
// DB): the Spain pre-filter (T131/T136), draft shape, and idempotency. Fixtures mirror
// parseTelegram's raw row: `raw_json = { kind: "telegram_post", post_ref, media_urls }`,
// the post body in `raw_text`, the first line as `title`, the t.me link as `url`.

const TODAY = new Date("2026-06-01T00:00:00Z");

// Build a synthetic telegram RawItem faithful to ingest.parseTelegram.
function tgItem(id, channel, postId, body, media = []) {
  const title = body.split("\n", 1)[0];
  return {
    id,
    source_key: CONCERTEN_SOURCE_KEY,
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

test("Valencia concert post is KEPT with Spain/Valencia city + concert + parsed date", () => {
  const rows = [
    tgItem(
      1,
      "concerten",
      "100",
      "Концерт Земфиры в Валенсии\n21 июня 2026\nPalau de la Música\nот 35 €",
      ["https://cdn.tg/poster1.jpg"],
    ),
  ];
  const out = buildConcertenEvents(rows, TODAY);
  assert.equal(out.length, 1, "Valencia post should be kept");
  const { draft, sourceItemId } = out[0];
  assert.equal(sourceItemId, 1);
  assert.equal(draft.country, "Spain");
  assert.equal(draft.city, "Valencia");
  assert.equal(draft.category, "concert");
  assert.equal(draft.language, "ru");
  assert.equal(draft.start_date, "2026-06-21");
  assert.equal(draft.source, CONCERTEN_SOURCE_KEY);
  assert.equal(draft.url, "https://t.me/concerten/100");
  assert.equal(draft.image_url, "https://cdn.tg/poster1.jpg");
  assert.ok(draft.title && draft.title.length > 0, "title is non-empty");
});

test("Madrid concert is KEPT (Spain) with city Madrid", () => {
  const rows = [
    tgItem(2, "concerten", "101", "Би-2 в Мадриде\n15 julio 2026\nWiZink Center"),
  ];
  const out = buildConcertenEvents(rows, TODAY);
  assert.equal(out.length, 1, "Madrid post should be kept");
  assert.equal(out[0].draft.city, "Madrid");
  assert.equal(out[0].draft.country, "Spain");
  assert.equal(out[0].draft.start_date, "2026-07-15");
});

test("Barcelona concert is KEPT (Spain) with city Barcelona", () => {
  const rows = [
    tgItem(3, "concerten", "102", "Ленинград в Барселоне\n10.09.2026\nPalau Sant Jordi"),
  ];
  const out = buildConcertenEvents(rows, TODAY);
  assert.equal(out.length, 1, "Barcelona post should be kept");
  assert.equal(out[0].draft.city, "Barcelona");
  assert.equal(out[0].draft.start_date, "2026-09-10");
});

test("Berlin/Paris/Lisbon tour post is DROPPED (non-Spain)", () => {
  const rows = [
    tgItem(4, "concerten", "103", "Большой тур\nБерлин 5 июня\nПариж 7 июня\nЛиссабон 9 июня"),
    tgItem(5, "concerten", "104", "Concert in Berlin\n12 June 2026\nMercedes-Benz Arena"),
  ];
  const out = buildConcertenEvents(rows, TODAY);
  assert.equal(out.length, 0, "non-Spain tour posts should all be dropped");
});

test("location-less post is DROPPED (conservative gate)", () => {
  const rows = [
    tgItem(6, "concerten", "105", "Скоро объявим новые даты! Следите за анонсами 🎶"),
    tgItem(7, "concerten", "106", "Билеты уже в продаже на все концерты"),
  ];
  const out = buildConcertenEvents(rows, TODAY);
  assert.equal(out.length, 0, "posts with no Spain signal should be dropped");
});

test("body-only Spain signal next to a non-Spain hub is DROPPED (ambiguous)", () => {
  // Title names only Berlin; the Spain signal (Madrid) lives only in the body.
  const rows = [
    tgItem(
      8,
      "concerten",
      "107",
      "Tour in Berlin\nДаты: Берлин 5 июня, Мадрид 8 июня",
    ),
  ];
  const out = buildConcertenEvents(rows, TODAY);
  assert.equal(out.length, 0, "Spain signal only in body + non-Spain hub → dropped");
});

test("Spain signal in the title survives even with a non-Spain hub in the body", () => {
  const rows = [
    tgItem(
      9,
      "concerten",
      "108",
      "Концерт в Мадриде\n8 июня 2026 — а до этого был Берлин",
    ),
  ];
  const out = buildConcertenEvents(rows, TODAY);
  assert.equal(out.length, 1, "Spain signal in title keeps the event");
  assert.equal(out[0].draft.city, "Madrid");
});

test("idempotency: same input twice yields identical drafts", () => {
  const rows = [
    tgItem(
      1,
      "concerten",
      "100",
      "Концерт Земфиры в Валенсии\n21 июня 2026\nPalau de la Música\nот 35 €",
      ["https://cdn.tg/poster1.jpg"],
    ),
    tgItem(2, "concerten", "101", "Би-2 в Мадриде\n15 julio 2026\nWiZink Center"),
  ];
  const a = buildConcertenEvents(rows, TODAY);
  const b = buildConcertenEvents(rows, TODAY);
  assert.deepEqual(a, b, "buildConcertenEvents is deterministic");
});

test("spainCity returns the matched city, not a blanket Valencia", () => {
  assert.equal(spainCity("концерт в Барселоне"), "Barcelona");
  assert.equal(spainCity("show in Sevilla"), "Sevilla");
  assert.equal(spainCity("концерт в Валенсии"), "Valencia");
  assert.equal(spainCity("nothing here"), null);
});

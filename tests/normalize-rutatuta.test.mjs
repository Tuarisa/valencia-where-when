import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRutatutaEvents,
  RUTATUTA_SOURCE_KEY,
} from "../lib/pipeline/normalizers/rutatuta.ts";

// T142 — rutatuta normalizer (telegram tg:rutatuta_vlc, "Валенсия с пристрастием", a
// local RU guide who runs DATED GUIDED EXCURSIONS). These tests exercise the PURE
// buildRutatutaEvents (no DB): a dated excursion is KEPT as category 'excursion' with a
// parsed date/price; channel chatter / undated teasers are DROPPED; output is
// deterministic. Fixtures mirror parseTelegram's raw row: `raw_json = { kind:
// "telegram_post", post_ref, media_urls }`, the post body in `raw_text`, the first line
// as `title`, the t.me link as `url`.

const TODAY = new Date("2026-06-01T00:00:00Z");

// Build a synthetic telegram RawItem faithful to ingest.parseTelegram.
function tgItem(id, postId, body, media = []) {
  const title = body.split("\n", 1)[0];
  return {
    id,
    source_key: RUTATUTA_SOURCE_KEY,
    item_type: "mixed",
    external_id: `rutatuta_vlc/${postId}`,
    title: title.slice(0, 200),
    url: `https://t.me/rutatuta_vlc/${postId}`,
    published_at: null,
    raw_text: body,
    raw_html: null,
    raw_json: JSON.stringify({
      kind: "telegram_post",
      post_ref: `rutatuta_vlc/${postId}`,
      media_urls: media,
    }),
    last_seen: "2026-06-01T00:00:00Z",
  };
}

test("source key matches sources.json (tg:rutatuta_vlc)", () => {
  assert.equal(RUTATUTA_SOURCE_KEY, "tg:rutatuta_vlc");
});

test("dated guided excursion is KEPT as category 'excursion' with parsed date + price", () => {
  const rows = [
    tgItem(
      909,
      "905",
      '🔥 Дополнительная групповая экскурсия "Валенсия с пристрастием" ✨\n17 июня, 10:30\n📍 Plaza de Ayuntamiento под балконом мэрии\n🕔 2,5 часа\n💶 25 евро с человека',
      ["https://cdn.tg/excursion.jpg"],
    ),
  ];
  const out = buildRutatutaEvents(rows, TODAY);
  assert.equal(out.length, 1, "dated excursion should be kept");
  const { draft, sourceItemId } = out[0];
  assert.equal(sourceItemId, 909);
  assert.equal(draft.category, "excursion", "tagged as an excursion");
  assert.equal(draft.language, "ru");
  assert.equal(draft.city, "Valencia");
  assert.equal(draft.country, "Spain");
  assert.equal(draft.start_date, "2026-06-17", "parses RU '17 июня'");
  assert.equal(draft.price, "25 €", "parses '25 евро'");
  assert.equal(draft.is_free, 0);
  assert.equal(draft.source, RUTATUTA_SOURCE_KEY);
  assert.equal(draft.url, "https://t.me/rutatuta_vlc/905");
  assert.equal(draft.image_url, "https://cdn.tg/excursion.jpg");
  assert.ok(draft.title && draft.title.length > 0, "title is non-empty");
});

test("a second dated excursion (different month) is KEPT with its own date", () => {
  const rows = [
    tgItem(
      907,
      "903",
      "5 июня 10:30 👉 Место с историей 👉 Римский цирк, еврейский квартал, старейшая церковь города",
    ),
  ];
  const out = buildRutatutaEvents(rows, TODAY);
  assert.equal(out.length, 1, "dated excursion should be kept");
  assert.equal(out[0].draft.category, "excursion");
  assert.equal(out[0].draft.start_date, "2026-06-05", "parses RU '5 июня'");
});

test("channel chatter (article, no date) is DROPPED", () => {
  const rows = [
    tgItem(
      235,
      "271",
      'Совсем забыла вам рассказать, что в конце марта в "Коммерсанте" вышла моя статья про несчастную Ноэлию Кастильо',
    ),
  ];
  const out = buildRutatutaEvents(rows, TODAY);
  assert.equal(out.length, 0, "undated chatter has no excursion date → dropped");
});

test("undated 'save the schedule' teaser is DROPPED", () => {
  const rows = [
    tgItem(
      243,
      "281",
      "Водный трибунал, гастрономия, мидии, приморские районы. Сохраняйте анонс групповых экскурсий в мае ⬇️ ⬇️ ⬇️",
    ),
  ];
  const out = buildRutatutaEvents(rows, TODAY);
  assert.equal(out.length, 0, "an announcement with no own date is dropped");
});

test("bare channel-header / media-meta card is DROPPED", () => {
  const rows = [
    tgItem(240, "276", "Валенсия с пристрастием"),
    tgItem(
      237,
      "273",
      "Валенсия с пристрастием 0:27 This media is not supported in your browser VIEW IN TELEGRAM",
    ),
  ];
  const out = buildRutatutaEvents(rows, TODAY);
  assert.equal(out.length, 0, "header / media-meta cards carry no event content");
});

test("idempotency: same input twice yields identical drafts", () => {
  const rows = [
    tgItem(
      909,
      "905",
      '🔥 Групповая экскурсия "Валенсия с пристрастием" ✨\n17 июня, 10:30\n📍 Plaza de Ayuntamiento\n💶 25 евро',
      ["https://cdn.tg/excursion.jpg"],
    ),
    tgItem(235, "271", "Просто новость без даты про статью в газете"),
  ];
  const a = buildRutatutaEvents(rows, TODAY);
  const b = buildRutatutaEvents(rows, TODAY);
  assert.deepEqual(a, b, "buildRutatutaEvents is deterministic");
  assert.equal(a.length, 1, "only the dated excursion survives");
});

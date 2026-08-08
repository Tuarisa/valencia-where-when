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

// Build a synthetic telegram RawItem faithful to ingest.parseTelegram. `opts` lets a
// T207 fixture carry the live row's published_at/first_seen (the post-date anchor).
function tgItem(id, postId, body, media = [], opts = {}) {
  const title = body.split("\n", 1)[0];
  return {
    id,
    source_key: RUTATUTA_SOURCE_KEY,
    item_type: "mixed",
    external_id: `rutatuta_vlc/${postId}`,
    title: title.slice(0, 200),
    url: `https://t.me/rutatuta_vlc/${postId}`,
    published_at: opts.published_at ?? null,
    raw_text: body,
    raw_html: null,
    raw_json: JSON.stringify({
      kind: "telegram_post",
      post_ref: `rutatuta_vlc/${postId}`,
      media_urls: media,
    }),
    first_seen: opts.first_seen ?? undefined,
    last_seen: opts.last_seen ?? "2026-06-01T00:00:00Z",
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

// ---------------------------------------------------------------------------
// T207 — year inference is anchored to the POST date, not to normalize time.
// Fixtures below are VERBATIM raw_text/timestamps from the live DB rows that
// produced the 2026/2027 twins (source_items 1412, 239, 2025).
// ---------------------------------------------------------------------------

// Live row 1412 (rutatuta_vlc/294, published 2026-06-26): «План на 12 июля» was
// re-normalized on 2026-08-07 — after July 12 had passed — and rolled to 2027-07-12,
// creating a twin of the correct 2026-07-12 row under a new hash.
const LAVENDER_BODY = `🪻 Самая долгожданная поездка этого лета! 💜 Вот уже четвертый (!) год подряд мы официально сотрудничаем с единственной фирмой, которая владеет лавандовыми полями в нашем регионе. План на 12 июля такой: 💜 Утром едем в городок Castielfabib, там нас встречают и проводят экскурсию. Средневековые стены, потрясающие виды. 💜 Обедаем в деревенском ресторане 💜 Встречаемся с хозяйкой лавандовых полей и едем на точку (они просят держать локацию в тайне) 💜 Гуляем по лавандовым полям, фотографируемся, хозяева проводят нам экскурсию, учат разбираться в сортах лаванды, отвечают на вопросы и проводят нюхательную дегустацию натуральных эфирных масел. При желании масла можно будет там же и купить. 💜 Возвращаемся в Валенсию после 19:00 ☝️ Поездка на своих машинах ⚡️ Стоимость 35 евро с человека. В стоимость входят экскурсии по Castielfabib и лаванде, обед оплачивается отдельно. Дети до 12 бесплатно ⚡️ Есть 3 места с нами в микроавтобусе, стоимость с трансфером 65 евро с человека, дети 50 евро. Пишите @tkhrylova`;
const LAVENDER_OPTS = {
  published_at: "2026-06-26T14:19:31+00:00",
  first_seen: "2026-07-02T21:05:16Z",
  last_seen: "2026-08-07T21:40:37Z",
};

test("T207: year anchors to the POST date — «12 июля» published 2026-06-26 stays 2026 when normalized after the date passed", () => {
  const rows = [tgItem(1412, "294", LAVENDER_BODY, [], LAVENDER_OPTS)];
  // 2026-08-07T21:43 = the live re-normalize moment that fabricated the 2027 twin.
  const out = buildRutatutaEvents(rows, new Date("2026-08-07T21:43:34Z"));
  assert.equal(out.length, 1, "dated excursion should be kept");
  assert.equal(out[0].draft.start_date, "2026-07-12", "post-date anchor, no roll to 2027");
});

test("T207: stable across normalize times — same post, before vs after the event date, same start_date", () => {
  const rows = [tgItem(1412, "294", LAVENDER_BODY, [], LAVENDER_OPTS)];
  const before = buildRutatutaEvents(rows, new Date("2026-06-27T00:00:00Z"));
  const after = buildRutatutaEvents(rows, new Date("2026-08-07T21:43:34Z"));
  assert.deepEqual(before, after, "normalize time must not change the draft (hash stability)");
  assert.equal(before[0].draft.start_date, "2026-07-12");
});

// Live row 239 (rutatuta_vlc/275, published_at NULL, first scraped 2026-06-20): the
// Mallorca day-tour «Едем 22 мая» was first seen ~a month AFTER the tour → inference
// rolled it to 2027-05-22. A past excursion is history, not next year's event.
test("T207: past date is NOT rolled a year forward — «22 мая» first seen 2026-06-20 resolves to 2026-05-22", () => {
  const rows = [
    tgItem(
      239,
      "275",
      "Дорогие, я подготовил однодневный тур на Майорку. Едем 22 мая (это пятница). Группа 8 человек. Что делаем: 🍷 1) Прилетаем утром, я беру в аренду минивэн — едем на винодельню 4kilos, знакомимся с производством, пробуем вина, ну вы люди опытные, знаете, как это бывает :) 🥩 2) После винодельни: едем в деревенский ресторан Cal Dimoni: традиционная майоркинская кухня, культовое место, меню скину отдельно. 🚶‍♂️ 3) Дальше едем в Пальму , гуляем по городу, немного истории, немного атмосферы, без перегруза. Свободное время. 💸 Стоимость: 125 € с человека Включено : винодельня, транспорт, сопровождение. Не включено : билеты на самолет, обед, сувениры. ✈️ Что по авиа билетам: 22 мая есть рейс Ryanair, вылет утром в 7:15 , прибываем в Пальму в 8:15 , успеваем загрузиться в машину, позавтракать в Пальме, потом на винодельню. Обратный вылет есть в 16:40 , есть в 22:40 (я улетаю последним рейсом). Стоит билет 38 евро туда-обратно. Надо ловить пока есть! Для брони тура нужно внести предоплату 125 евро — по ссылке.",
      [],
      { published_at: null, first_seen: "2026-06-20T22:28:54Z", last_seen: "2026-06-24T21:31:29Z" },
    ),
  ];
  const out = buildRutatutaEvents(rows, new Date("2026-06-24T21:33:47Z"));
  assert.equal(out.length, 1, "dated tour should be kept (as history)");
  assert.equal(out[0].draft.start_date, "2026-05-22", "past tour keeps its real 2026 date");
});

test("T207: legitimate Dec→Jan cross-year roll is KEPT (announcement within the horizon)", () => {
  const rows = [
    tgItem(
      950,
      "950",
      '🔥 Групповая экскурсия "Валенсия с пристрастием" ✨\n3 января, 11:00\n📍 Plaza de la Virgen у фонтана\n💶 25 евро с человека',
      [],
      { published_at: "2026-12-28T10:00:00+00:00", last_seen: "2026-12-28T10:00:00Z" },
    ),
  ];
  const out = buildRutatutaEvents(rows, new Date("2026-12-28T12:00:00Z"));
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, "2027-01-03", "6 days ahead across New Year → next year");
});

test("T207: an explicit year in the text always wins over the anchor", () => {
  const rows = [
    tgItem(
      951,
      "951",
      '🔥 Групповая экскурсия "Валенсия с пристрастием" ✨\n18 марта 2027, 10:30\n📍 Plaza de Ayuntamiento\n💶 25 евро с человека',
      [],
      { published_at: "2026-06-26T14:19:31+00:00" },
    ),
  ];
  const out = buildRutatutaEvents(rows, new Date("2026-08-07T21:43:34Z"));
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, "2027-03-18", "explicit 2027 is trusted as-is");
});

// Live row 2025 (rutatuta_vlc/304): the telegram service card «<channel> pinned « … »»
// quotes an excerpt of the pinned post — the post itself arrives as its own row, so the
// card only duplicated the excursion under a second title (live event 27326).
test("T207: '<channel> pinned « … »' service card is DROPPED", () => {
  const rows = [
    tgItem(
      2025,
      "304",
      "Валенсия с пристрастием pinned « 7 июля, 19:00 👉 Вся неправда про Валенсию 👉 Экскурсия-фактчек: разбираем самые популярные байки и легенды Валенсии. Слышали, что палачи точили топор об Кафедральный собор, что статуи Девы Марии крутятся вокруг своей оси, и что в одном из памятников Валенсии… »",
      [],
      { published_at: "2026-07-10T18:57:39+00:00", last_seen: "2026-08-07T21:40:38Z" },
    ),
  ];
  const out = buildRutatutaEvents(rows, new Date("2026-08-07T21:43:34Z"));
  assert.equal(out.length, 0, "pinned service card is chrome, not a post");
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

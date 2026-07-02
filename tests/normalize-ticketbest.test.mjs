import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TICKETBEST_SOURCE_KEY,
  tbMonth,
  parseTbDate,
  parseTbCards,
  isSpainCountry,
  isValenciaSlug,
  isCvCity,
  cleanTbTitle,
  buildTicketbestEvents,
} from "../lib/pipeline/normalizers/ticketbest.ts";
import { resolveNormalizer } from "../lib/pipeline/normalize.ts";

// Fixtures faithful to the REAL ticketbest.eu homepage as captured by the generic web
// parser (verified live 2026-07-02): a `page_snapshot` whose stripped raw_text renders
// each performance card as consecutive lines —
//   L / • / <D month YYYY> / <HH:MM> / <Title … | City> / <Country, City, Venue…> /
//   Osta pilet
// (Estonian chrome: weekday letter, "Osta pilet" buy button, month names) — plus one
// `link_card` row per performance (title + /performances/<slug>?event_id=N URL, no
// date). The slug ENDS with the city (…-valencia, …-riga).

const VLC_URL =
  "https://www.ticketbest.eu/performances/una-estrella-llamada-sol-zvezda-po-imeni-solntse-valencia?event_id=1127";
const ALC_URL =
  "https://www.ticketbest.eu/performances/una-estrella-llamada-sol-zvezda-po-imeni-solntse-alicante?event_id=1128";
const RIGA_URL =
  "https://www.ticketbest.eu/performances/italian-giuseppe-verdi-string-orchestra-riga?event_id=1098";
const NARVA_URL =
  "https://www.ticketbest.eu/performances/los-vivancos-live-hispaania-geneva-narva?event_id=1078";

const VLC_TITLE = '"Una estrella llamada Sol" / "Звезда по имени Солнце" | València';
const ALC_TITLE = '"Una estrella llamada Sol" / "Звезда по имени Солнце" | Alicante';

// Structurally faithful trimmed snapshot: Riga + Narva (the Spain-THEMED show that
// plays in Estonia) + Alicante + Valencia + a Madrid non-headliner + a Madrid headliner.
const SNAPSHOT_TEXT = [
  "Kõik üritused",
  "L",
  "•",
  "7 november 2026",
  "19:00",
  "ITALIAN GIUSEPPE VERDI STRING ORCHESTRA | Riga",
  "Läti, Rīga, Rīgas Latviešu biedrības nams",
  "Osta pilet",
  "R",
  "•",
  "13 november 2026",
  "19:00",
  "LOS VIVANCOS - LIVE - Hispaania | Geneva Narva",
  "Eesti, Narva, Geneva Kontserdimaja",
  "Osta pilet",
  "N",
  "•",
  "12 november 2026",
  "20:00",
  ALC_TITLE,
  "Hispaania, Alicante, VB Spaces",
  "Osta pilet",
  "L",
  "•",
  "14 november 2026",
  "20:00",
  VLC_TITLE,
  "Hispaania, Valencia, Sala Madison Concert Club, València",
  "Osta pilet",
  "P",
  "•",
  "15 november 2026",
  "20:00",
  '"Una estrella llamada Sol" / "Звезда по имени Солнце" | Marbella',
  "Hispaania, Marbella, Palacio de Congresos Marbella (AUDITÓRIUM B)",
  "Osta pilet",
  "P",
  "•",
  "20 detsember 2026",
  "21:00",
  "Некий камерный вечер | Madrid",
  "Hispaania, Madrid, Sala Pequeña",
  "Osta pilet",
  "P",
  "•",
  "21 detsember 2026",
  "21:00",
  "Sting — My Songs | Madrid",
  "Hispaania, Madrid, WiZink Center",
  "Osta pilet",
].join("\n");

const SNAPSHOT_ROW = {
  id: 9001,
  source_key: TICKETBEST_SOURCE_KEY,
  item_type: "snapshot",
  title: "TicketBest",
  url: "https://www.ticketbest.eu",
  raw_text: SNAPSHOT_TEXT,
  raw_json: JSON.stringify({ kind: "page_snapshot", meta: {}, event_links: [] }),
};

const linkCard = (id, title, url) => ({
  id,
  source_key: TICKETBEST_SOURCE_KEY,
  item_type: "mixed",
  title,
  url,
  raw_text: title,
  raw_json: JSON.stringify({ kind: "link_card", source_page: "https://www.ticketbest.eu" }),
});

const ROWS = [
  SNAPSHOT_ROW,
  linkCard(9002, "ITALIAN GIUSEPPE VERDI STRING ORCHESTRA | Riga", RIGA_URL),
  linkCard(9003, "LOS VIVANCOS - LIVE - Hispaania | Geneva Narva", NARVA_URL),
  linkCard(9004, ALC_TITLE, ALC_URL),
  linkCard(9005, VLC_TITLE, VLC_URL),
];

// ── unit helpers ────────────────────────────────────────────────────────────

test("tbMonth: Estonian / English / Russian month words resolve", () => {
  assert.equal(tbMonth("november"), 11); // et = en
  assert.equal(tbMonth("detsember"), 12); // Estonian December
  assert.equal(tbMonth("märts"), 3);
  assert.equal(tbMonth("декабря"), 12);
  assert.equal(tbMonth("July"), 7);
  assert.equal(tbMonth("mitte-kuu"), 0);
});

test("parseTbDate: '<D month YYYY>' card line → ISO; junk → null", () => {
  assert.equal(parseTbDate("14 november 2026"), "2026-11-14");
  assert.equal(parseTbDate("20 detsember 2026"), "2026-12-20");
  assert.equal(parseTbDate("Osta pilet"), null);
  assert.equal(parseTbDate("14 november"), null); // no year → not a card date line
  assert.equal(parseTbDate("99 november 2026"), null);
});

test("isSpainCountry: Estonian 'Hispaania' and friends; Baltic countries rejected", () => {
  assert.equal(isSpainCountry("Hispaania"), true);
  assert.equal(isSpainCountry("Spain"), true);
  assert.equal(isSpainCountry("Испания"), true);
  assert.equal(isSpainCountry("Eesti"), false);
  assert.equal(isSpainCountry("Läti"), false);
  assert.equal(isSpainCountry(null), false);
});

test("isValenciaSlug: slug tail city is the core signal", () => {
  assert.equal(isValenciaSlug(VLC_URL), true);
  assert.equal(isValenciaSlug(RIGA_URL), false);
  assert.equal(isValenciaSlug(ALC_URL), false); // Alicante ≠ Valencia slug
  assert.equal(isValenciaSlug(null), false);
});

test("isCvCity: affirmative CV match only — NO default-true fallback for unknown cities", () => {
  assert.equal(isCvCity("Valencia"), true);
  assert.equal(isCvCity("València"), true);
  assert.equal(isCvCity("Alicante"), true);
  assert.equal(isCvCity("Castellón"), true);
  // the live-data leak: Marbella is Spain but NOT Comunitat Valenciana — and it is in
  // neither of lacotorra's stem lists, so isValenciaRegion would default it to TRUE.
  assert.equal(isCvCity("Marbella"), false);
  assert.equal(isCvCity("Madrid"), false);
  assert.equal(isCvCity(""), false);
  assert.equal(isCvCity(null), false);
});

test("cleanTbTitle: strips the trailing '| City' chip, keeps the bilingual title", () => {
  assert.equal(
    cleanTbTitle(VLC_TITLE),
    '"Una estrella llamada Sol" / "Звезда по имени Солнце"',
  );
  assert.equal(cleanTbTitle("Sting — My Songs | Madrid"), "Sting — My Songs");
  assert.equal(cleanTbTitle("No city suffix"), "No city suffix");
});

test("parseTbCards: reconstructs date/time/title/country/city/venue per card", () => {
  const cards = parseTbCards(SNAPSHOT_TEXT);
  assert.equal(cards.length, 7);
  const vlc = cards.find((c) => c.title === VLC_TITLE);
  assert.ok(vlc, "Valencia card parsed");
  assert.equal(vlc.date, "2026-11-14");
  assert.equal(vlc.time, "20:00");
  assert.equal(vlc.country, "Hispaania");
  assert.equal(vlc.city, "Valencia");
  assert.equal(vlc.venue, "Sala Madison Concert Club");
  assert.equal(vlc.address, "Sala Madison Concert Club, València");
});

// ── build: the Valencia filter (T170 hybrid) ────────────────────────────────

test("build: keeps the Valencia performance with date, time, venue and its OWN URL", () => {
  const drafts = buildTicketbestEvents(ROWS);
  const vlc = drafts.find((d) => d.draft.city === "Valencia");
  assert.ok(vlc, "Valencia event emitted");
  assert.equal(vlc.draft.title, '"Una estrella llamada Sol" / "Звезда по имени Солнце"');
  assert.equal(vlc.draft.start_date, "2026-11-14");
  assert.equal(vlc.draft.start_time, "20:00");
  assert.equal(vlc.draft.venue_name, "Sala Madison Concert Club");
  assert.equal(vlc.draft.url, VLC_URL, "per-performance URL matched from the link_card");
  assert.equal(vlc.draft.source_url, VLC_URL);
  assert.equal(vlc.draft.source, TICKETBEST_SOURCE_KEY);
  assert.equal(vlc.sourceItemId, SNAPSHOT_ROW.id, "emitted off the snapshot row");
});

test("build: drops non-Spain cards (Riga) — an all-Europe site must not flood the feed", () => {
  const drafts = buildTicketbestEvents(ROWS);
  assert.equal(
    drafts.some((d) => /VERDI/i.test(d.draft.title)),
    false,
    "Riga orchestra dropped",
  );
});

test("build: a Spain-THEMED show in Estonia is dropped (address country wins over title)", () => {
  // "LOS VIVANCOS - LIVE - Hispaania | Geneva Narva" says Spain in the TITLE but the
  // card address is "Eesti, Narva, …" — must be dropped.
  const drafts = buildTicketbestEvents(ROWS);
  assert.equal(drafts.some((d) => /VIVANCOS/i.test(d.draft.title)), false);
});

test("build: Alicante (Comunitat Valenciana) is kept with its real city", () => {
  const drafts = buildTicketbestEvents(ROWS);
  const alc = drafts.find((d) => d.draft.city === "Alicante");
  assert.ok(alc, "CV-region event kept (T170: region always)");
  assert.equal(alc.draft.start_date, "2026-11-12");
  assert.equal(alc.draft.url, ALC_URL);
});

test("build: Marbella (Spain but NOT Comunitat Valenciana, no headliner) is dropped", () => {
  // Live regression: the SAME tribute show also plays Marbella (event_id=1126). Spain
  // country gate passes, but Marbella is outside the CV region and not a headliner —
  // the strict isCvCity gate must drop it (isValenciaRegion's default-true kept it).
  const drafts = buildTicketbestEvents(ROWS);
  assert.equal(drafts.some((d) => d.draft.city === "Marbella"), false);
});

test("build: Madrid non-headliner dropped, Madrid headliner kept (T170 hybrid)", () => {
  const drafts = buildTicketbestEvents(ROWS);
  assert.equal(
    drafts.some((d) => /камерный вечер/i.test(d.draft.title)),
    false,
    "non-headliner Madrid card dropped",
  );
  const sting = drafts.find((d) => /sting/i.test(d.draft.title));
  assert.ok(sting, "headliner (Sting) survives outside the CV region");
  assert.equal(sting.draft.city, "Madrid");
});

test("build: link_card rows alone (dateless) emit NOTHING — processed but not emitted", () => {
  const onlyCards = ROWS.filter(
    (r) => JSON.parse(r.raw_json).kind === "link_card",
  );
  assert.deepEqual(buildTicketbestEvents(onlyCards), []);
});

test("build: no matching link_card → URL falls back to the homepage, event still emitted", () => {
  const noLinks = [SNAPSHOT_ROW];
  const drafts = buildTicketbestEvents(noLinks);
  const vlc = drafts.find((d) => d.draft.city === "Valencia");
  assert.ok(vlc);
  assert.equal(vlc.draft.url, "https://www.ticketbest.eu");
});

test("build: repeated cards across page sections are de-duplicated", () => {
  const doubled = {
    ...SNAPSHOT_ROW,
    raw_text: `${SNAPSHOT_TEXT}\n${SNAPSHOT_TEXT}`,
  };
  const drafts = buildTicketbestEvents([doubled, ...ROWS.slice(1)]);
  const vlcCount = drafts.filter((d) => d.draft.city === "Valencia").length;
  assert.equal(vlcCount, 1);
});

test("registry: web:ticketbest resolves to its normalizer", () => {
  assert.equal(typeof resolveNormalizer(TICKETBEST_SOURCE_KEY), "function");
});

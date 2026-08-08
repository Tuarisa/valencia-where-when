import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVENTBRITE_SOURCE_KEY,
  isEventbriteEventUrl,
  eventbriteCanonicalUrl,
  parseEventbriteTime,
  parseEventbriteDate,
  buildSnapshotIndex,
  buildEventbriteEvents,
  scrapeDateOf,
} from "../lib/pipeline/normalizers/eventbrite.ts";

// Weekday-of-an-ISO-date helper for the Bug-4 regression assertions (UTC-stable).
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function weekday(iso) {
  return WD[new Date(`${iso}T00:00:00`).getDay()];
}

// Fixed reference date so relative ("hoy"/"mañana"/weekday) parsing is deterministic.
// Saturday 2026-06-20 (matches the real snapshot capture: "hoy a las 22:30" cards).
const TODAY = new Date(2026, 5, 20); // 2026-06-20, a Saturday

// A snapshot fragment FAITHFUL to the live id=247 raw_text: each PHYSICAL Valencia card
// renders as "<title> <date-expr>\n<venue>\nCheck ticket price on event"; each ONLINE /
// out-of-town card renders as "<title> <date-expr-with-foreign-tz>\nCheck ticket price on
// event" (NO venue line). The live snapshot repeats cards 2–3× and carries chrome/badge
// lines ("After 8pm", "Sales end soon", "Save this event: …"). CRITICAL: the snapshot lists
// MORE events than the link_cards — "Música coral en directo", "PENYAIR en VALENCIA",
// "Inside Daidalonic 2026" have NO /e/ link_card but ARE real, dated Valencia events.
const SNAPSHOT_TEXT = [
  "Los mejores eventos en",
  "Valencia",
  "After 8pm",
  "Explore more events",
  // physical Valencia cards (venue line precedes the marker)
  "Pub Crawl Valencia by Mad Party Crew hoy a las 22:30 + 1 more",
  "Bear Club - Valencia",
  "Check ticket price on event",
  "Jazz at Loom. Every Sunday jazz Jam session. mañana a las 20:30",
  "LOOM VLC",
  "Check ticket price on event",
  // dated Valencia events with NO link_card anchor — these were dropped before the fix
  "Música coral en directo Sat, Jun 27, 8:30 PM",
  "Real Parroquia de los Santos Juanes Valencia",
  "Check ticket price on event",
  "Inside Daidalonic 2026 Mon, Jun 29, 5:30 PM",
  "Paraninfo UPV",
  "Check ticket price on event",
  "Jornada PrimeTime Project viernes a las 09:00",
  "UPV - Escuela Técnica Superior de Ingeniería Informática ETSINF",
  "Check ticket price on event",
  "Fuckup Nights Valencia Vol. XLIV Thu, Jul 2, 7:00 PM",
  "ADEIT - Fundación Universidad - Empresa de la Universitat de València",
  "Check ticket price on event",
  "Saturday Language Exchange & Party hoy a las 20:30",
  "C/ del Convent de Sant Francesc, 2",
  "Check ticket price on event",
  // repeated card (the live page renders each twice) — must de-dupe by title
  "Pub Crawl Valencia by Mad Party Crew hoy a las 22:30 + 1 more",
  "Bear Club - Valencia",
  "Check ticket price on event",
  // ONLINE / out-of-town cards (foreign tz, NO venue line) — must be dropped
  "Online Events",
  "An Introduction to PDA for Educators miércoles a las 16:00 GMT+1",
  "Check ticket price on event",
  "San Diego Career Fair Mon, Jul 27, 9:30 AM PDT",
  "Check ticket price on event",
].join("\n");

// Build a row set faithful to the live shape: one page_snapshot + link_cards (event +
// chrome + a duplicate-by-aff event). raw_text == title for every link_card.
function linkCard(id, title, url) {
  return {
    id,
    source_key: EVENTBRITE_SOURCE_KEY,
    item_type: "mixed",
    title,
    url,
    raw_text: title,
    raw_json: JSON.stringify({ kind: "link_card", source_page: "https://www.eventbrite.es/d/spain--valencia/events/" }),
  };
}

const ROWS = [
  {
    id: 247,
    source_key: EVENTBRITE_SOURCE_KEY,
    item_type: "snapshot",
    title: "Eventos en Valencia | Eventbrite",
    url: "https://www.eventbrite.es/d/spain--valencia/events/",
    raw_text: SNAPSHOT_TEXT,
    raw_json: JSON.stringify({ kind: "page_snapshot", meta: { "og:image": "https://cdn.evbstatic.com/logo.png" } }),
  },
  // /e/ link_cards that ALSO appear in the snapshot → snapshot card emits, /e/ url attached
  linkCard(254, "Pub Crawl Valencia by Mad Party Crew", "https://www.eventbrite.es/e/entradas-pub-crawl-valencia-by-mad-party-crew-1777986297879?aff=ebdssbcitybrowsenightlife"),
  // SAME event, different ?aff= → must de-dupe to one canonical url
  linkCard(263, "Pub Crawl Valencia by Mad Party Crew", "https://www.eventbrite.es/e/entradas-pub-crawl-valencia-by-mad-party-crew-1777986297879?aff=ebdssbcitybrowse"),
  linkCard(255, "Jazz at Loom. Every Sunday jazz Jam session.", "https://www.eventbrite.es/e/jazz-at-loom-every-sunday-jazz-jam-session-tickets-1807073859559?aff=ebdssbcitybrowsenightlife"),
  linkCard(259, "Jornada PrimeTime Project", "https://www.eventbrite.es/e/entradas-jornada-primetime-project-1988320110976?aff=ebdssbcitybrowse"),
  linkCard(260, "Fuckup Nights Valencia Vol. XLIV", "https://www.eventbrite.es/e/fuckup-nights-valencia-vol-xliv-tickets-1992117357643?aff=ebdssbcitybrowse"),
  linkCard(264, "Saturday Language Exchange & Party", "https://www.eventbrite.es/e/entradas-saturday-language-exchange-party-799030370347?aff=ebdssbcitybrowse"),
  // a real /e/ event with NO snapshot card (e.g. snapshot truncated) → still emits, undated
  linkCard(261, "SUMMER MEETUP | València Nomads Hub", "https://www.eventbrite.es/e/entradas-summer-meetup-valencia-nomads-hub-1991449810993?aff=ebdssbcitybrowse"),
  // chrome / nav / poi — all must be dropped
  linkCard(252, "Things to do in Valencia", "https://www.eventbrite.es/ttd/spain--valencia/"),
  linkCard(253, "Explore more events", "https://www.eventbrite.es/b/spain--valencia/nightlife/"),
  linkCard(256, "Popular in Valencia", "https://www.eventbrite.es/d/spain--valencia/all-events/"),
  linkCard(268, "Valencia Cathedral", "https://www.eventbrite.es/poi/spain--valencia/valencia-cathedral--5gB9j/"),
  linkCard(250, "Classes & Workshops", "https://www.eventbrite.es/organizer/event-type/create-a-workshop/"),
  linkCard(298, "Organización conciertos", "https://www.eventbrite.es/l/music/"),
  linkCard(307, "Manage Cookie Preferences", "https://www.eventbrite.es/d/spain--valencia/events/#"),
];

test("EVENTBRITE_SOURCE_KEY matches sources.json", () => {
  assert.equal(EVENTBRITE_SOURCE_KEY, "web:eventbrite");
});

test("isEventbriteEventUrl keeps only /e/ links", () => {
  assert.equal(isEventbriteEventUrl("https://www.eventbrite.es/e/foo-123?aff=x"), true);
  assert.equal(isEventbriteEventUrl("https://www.eventbrite.es/poi/spain--valencia/x/"), false);
  assert.equal(isEventbriteEventUrl("https://www.eventbrite.es/d/spain--valencia/events/"), false);
  assert.equal(isEventbriteEventUrl(null), false);
});

test("eventbriteCanonicalUrl strips the ?aff query", () => {
  assert.equal(
    eventbriteCanonicalUrl("https://www.eventbrite.es/e/x-123?aff=a"),
    "https://www.eventbrite.es/e/x-123",
  );
  assert.equal(
    eventbriteCanonicalUrl("https://www.eventbrite.es/e/x-123?aff=b"),
    "https://www.eventbrite.es/e/x-123",
  );
});

test("parseEventbriteTime handles 24h 'a las' and 12h AM/PM", () => {
  assert.equal(parseEventbriteTime("hoy a las 22:30 + 1 more"), "22:30");
  assert.equal(parseEventbriteTime("mañana a las 09:30"), "09:30");
  assert.equal(parseEventbriteTime("Thu, Jul 2, 7:00 PM"), "19:00");
  assert.equal(parseEventbriteTime("Sat, Jun 27, 8:30 AM"), "08:30");
  assert.equal(parseEventbriteTime("no time here"), null);
});

test("parseEventbriteDate resolves hoy/mañana/weekday/absolute", () => {
  // hoy → 2026-06-20 (the reference Saturday)
  assert.equal(parseEventbriteDate("hoy a las 22:30", TODAY), "2026-06-20");
  // mañana → 2026-06-21
  assert.equal(parseEventbriteDate("mañana a las 20:30", TODAY), "2026-06-21");
  // viernes (Fri) from a Saturday → next Friday 2026-06-26
  assert.equal(parseEventbriteDate("viernes a las 09:00", TODAY), "2026-06-26");
  // miércoles (Wed) → next Wednesday 2026-06-24
  assert.equal(parseEventbriteDate("miércoles a las 16:00 GMT+1", TODAY), "2026-06-24");
  // English absolute "Thu, Jul 2" → 2026-07-02
  assert.equal(parseEventbriteDate("Thu, Jul 2, 7:00 PM", TODAY), "2026-07-02");
  assert.equal(parseEventbriteDate("", TODAY), null);
});

test("buildSnapshotIndex maps title → { title, dateExpr, venue, online }", () => {
  const idx = buildSnapshotIndex(SNAPSHOT_TEXT);
  const pub = idx.get("pub crawl valencia by mad party crew");
  assert.ok(pub, "Pub Crawl indexed");
  assert.equal(pub.title, "Pub Crawl Valencia by Mad Party Crew");
  assert.equal(pub.dateExpr, "hoy a las 22:30"); // "+ 1 more" trimmed
  assert.equal(pub.venue, "Bear Club - Valencia");
  assert.equal(pub.online, false);

  const fuckup = idx.get("fuckup nights valencia vol. xliv");
  assert.ok(fuckup);
  assert.equal(fuckup.dateExpr, "Thu, Jul 2, 7:00 PM");
  assert.equal(fuckup.venue, "ADEIT - Fundación Universidad - Empresa de la Universitat de València");
  assert.equal(fuckup.online, false);

  // A dated card with NO /e/ link_card is STILL in the snapshot (the bug: these were lost).
  const coral = idx.get("musica coral en directo");
  assert.ok(coral, "snapshot-only card 'Música coral en directo' indexed");
  assert.equal(coral.dateExpr, "Sat, Jun 27, 8:30 PM");
  assert.equal(coral.venue, "Real Parroquia de los Santos Juanes Valencia");

  // Online cards: no venue line + foreign tz → flagged online.
  const pda = idx.get("an introduction to pda for educators");
  assert.ok(pda, "online card indexed (so the caller can drop it)");
  assert.equal(pda.venue, null);
  assert.equal(pda.online, true);
  const sandiego = idx.get("san diego career fair");
  assert.ok(sandiego);
  assert.equal(sandiego.online, true);
});

test("buildEventbriteEvents: snapshot-driven — emits snapshot-only events, drops online + chrome", () => {
  const events = buildEventbriteEvents(ROWS, TODAY);

  // The snapshot's PHYSICAL Valencia cards (de-duped) + the link_card-only SUMMER MEETUP.
  // CRITICAL: Música coral / Inside Daidalonic have NO /e/ anchor but ARE emitted now.
  const titles = events.map((e) => e.draft.title).sort();
  assert.deepEqual(titles, [
    "Fuckup Nights Valencia Vol. XLIV",
    "Inside Daidalonic 2026",
    "Jazz at Loom. Every Sunday jazz Jam session.",
    "Jornada PrimeTime Project",
    "Música coral en directo",
    "Pub Crawl Valencia by Mad Party Crew",
    "SUMMER MEETUP | València Nomads Hub",
    "Saturday Language Exchange & Party",
  ]);

  // No chrome / poi / nav / ONLINE cards leaked in.
  for (const t of titles) {
    assert.ok(!/things to do|explore more|popular in|cathedral|cookie|conciertos|workshops/i.test(t), `chrome leaked: ${t}`);
    assert.ok(!/introduction to pda|san diego|career fair/i.test(t), `online card leaked: ${t}`);
  }

  const byTitle = Object.fromEntries(events.map((e) => [e.draft.title, e.draft]));

  // Pub Crawl: hoy → 2026-06-20, time 22:30, venue from snapshot, ONLY ONCE (deduped).
  const pub = byTitle["Pub Crawl Valencia by Mad Party Crew"];
  assert.equal(pub.start_date, "2026-06-20");
  assert.equal(pub.start_time, "22:30");
  assert.equal(pub.venue_name, "Bear Club - Valencia");
  assert.ok(/eventbrite\.es\/e\//.test(pub.url), "snapshot card got its /e/ deep link");
  assert.equal(events.filter((e) => e.draft.title === "Pub Crawl Valencia by Mad Party Crew").length, 1);

  // Música coral: snapshot-only (NO link_card) → emits, DATED, venue, listing-page url.
  const coral = byTitle["Música coral en directo"];
  assert.equal(coral.start_date, "2026-06-27");
  assert.equal(coral.start_time, "20:30");
  assert.equal(coral.venue_name, "Real Parroquia de los Santos Juanes Valencia");
  assert.ok(/\/d\/spain--valencia\/events\//.test(coral.url), "no /e/ anchor → listing url");

  // Inside Daidalonic: snapshot-only, English absolute Mon, Jun 29 → 2026-06-29, 17:30.
  const inside = byTitle["Inside Daidalonic 2026"];
  assert.equal(inside.start_date, "2026-06-29");
  assert.equal(inside.start_time, "17:30");

  // Fuckup: English absolute → 2026-07-02, 19:00, with its /e/ link.
  const fk = byTitle["Fuckup Nights Valencia Vol. XLIV"];
  assert.equal(fk.start_date, "2026-07-02");
  assert.equal(fk.start_time, "19:00");

  // Jornada: weekday → next Friday 2026-06-26.
  assert.equal(byTitle["Jornada PrimeTime Project"].start_date, "2026-06-26");

  // SUMMER MEETUP: link_card with NO snapshot card → still emits, UNDATED fallback.
  const meetup = byTitle["SUMMER MEETUP | València Nomads Hub"];
  assert.equal(meetup.start_date, null);
  assert.equal(meetup.venue_name, null);
  assert.ok(/eventbrite\.es\/e\//.test(meetup.url), "fallback keeps the /e/ deep link");

  // Source / city / country invariants.
  for (const e of events) {
    assert.equal(e.draft.source, "web:eventbrite");
    assert.equal(e.draft.city, "Valencia");
    assert.equal(e.draft.country, "Spain");
  }
});

test("buildEventbriteEvents: an /e/ event with NO snapshot still emits undated", () => {
  const lone = [
    linkCard(900, "Some Untracked Concert", "https://www.eventbrite.es/e/some-untracked-concert-999?aff=x"),
  ];
  const events = buildEventbriteEvents(lone, TODAY);
  assert.equal(events.length, 1);
  assert.equal(events[0].draft.start_date, null);
  assert.equal(events[0].draft.venue_name, null);
  assert.equal(events[0].draft.title, "Some Untracked Concert");
});

// ===================== Bug 4: relative dates anchor to the SCRAPE date =====================

test("scrapeDateOf: parses the snapshot row's first_seen into a local midnight Date", () => {
  const d = scrapeDateOf({ first_seen: "2026-06-20T22:28:58Z" });
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5); // June (0-based)
  assert.equal(d.getDate(), 20);
  assert.equal(d.getDay(), 6); // Saturday
});

test("scrapeDateOf: falls back to last_seen, then null", () => {
  assert.equal(scrapeDateOf({ last_seen: "2026-06-20T10:00:00Z" }).getDate(), 20);
  assert.equal(scrapeDateOf({}), null);
  assert.equal(scrapeDateOf(null), null);
});

test("buildEventbriteEvents: relative dates resolve to the SCRAPE day, not the run day (Bug 4)", () => {
  // Snapshot scraped SATURDAY 2026-06-20; normalizer RUN on a different day (Jun 21).
  // Pre-fix this shifted every relative date +1 ("Saturday … hoy" stored as Sunday).
  const rowsWithScrape = ROWS.map((r) =>
    r.id === 247 ? { ...r, first_seen: "2026-06-20T22:28:58Z" } : r,
  );
  const RUN_DAY = new Date(2026, 5, 21); // a SUNDAY — deliberately != scrape day
  const events = buildEventbriteEvents(rowsWithScrape, RUN_DAY);
  const byTitle = Object.fromEntries(events.map((e) => [e.draft.title, e.draft]));

  // "Saturday Language Exchange & Party hoy a las 20:30" → scrape day Sat Jun 20.
  const sat = byTitle["Saturday Language Exchange & Party"];
  assert.ok(sat, "Saturday event present");
  assert.equal(sat.start_date, "2026-06-20");
  assert.equal(weekday(sat.start_date), "Sat", "title says Saturday → stored weekday is Saturday");

  // "Jazz at Loom. Every Sunday … mañana a las 20:30" → scrape day + 1 = Sun Jun 21.
  const jazz = byTitle["Jazz at Loom. Every Sunday jazz Jam session."];
  assert.ok(jazz, "Jazz event present");
  assert.equal(jazz.start_date, "2026-06-21");
  assert.equal(weekday(jazz.start_date), "Sun", "Every Sunday → stored weekday is Sunday");

  // "Jornada PrimeTime Project viernes a las 09:00" → next Friday on/after Sat Jun 20 = Jun 26.
  const fri = byTitle["Jornada PrimeTime Project"];
  assert.ok(fri, "Friday event present");
  assert.equal(weekday(fri.start_date), "Fri");
});

test("buildEventbriteEvents: no scrape timestamp → falls back to `today` (back-compat)", () => {
  // The existing ROWS fixture has no first_seen → behaviour is unchanged (anchors to TODAY).
  const events = buildEventbriteEvents(ROWS, TODAY); // TODAY = Sat 2026-06-20
  const byTitle = Object.fromEntries(events.map((e) => [e.draft.title, e.draft]));
  assert.equal(byTitle["Saturday Language Exchange & Party"].start_date, "2026-06-20");
});

// ================= T154: the SPANISH-locale snapshot (real rows 1114/1424/1724/2038) =================
// Eventbrite switched the served locale after the first scrape: the per-card price-marker
// became "Comprobar el precio de la entrada en el evento" (EN marker: 0 occurrences), the
// multi-session trailer became "+ N más", and a "Guarda este evento: … Compartir este
// evento: …" chrome line follows every marker. Matching only the EN marker made the
// snapshot index EMPTY for 4 of 5 live runs → only undated second-pass link_cards emitted.
// Every line below is verbatim from the live id=2038 raw_text (scraped Fri 2026-08-07).

const ES_SNAPSHOT_TEXT = [
  "Eventos, calendario y entradas en Valencia, España | Eventbrite",
  "Explorar más eventos",
  // physical cards: title+date / venue / marker / chrome
  "Pub Crawl Valencia by Mad Party Crew hoy a las 22:30 + 2 más",
  "La Cola Del Pez",
  "Comprobar el precio de la entrada en el evento",
  "Guarda este evento: Pub Crawl Valencia by Mad Party Crew Compartir este evento: Pub Crawl Valencia by Mad Party Crew",
  "Jazz at Loom. Every Sunday jazz Jam session. domingo a las 20:30",
  "LOOM VLC",
  "Comprobar el precio de la entrada en el evento",
  "Guarda este evento: Jazz at Loom. Every Sunday jazz Jam session. Compartir este evento: Jazz at Loom. Every Sunday jazz Jam session.",
  "FRANK HURRICANE (EE.UU) Thu, Sep 3, 8:00 PM",
  "Bar Centro Excursionista",
  "Comprobar el precio de la entrada en el evento",
  "Guarda este evento: FRANK HURRICANE (EE.UU) Compartir este evento: FRANK HURRICANE (EE.UU)",
  "Sip & Thrift mañana a las 12:00",
  "Monette pastisseria & café",
  "Comprobar el precio de la entrada en el evento",
  "Guarda este evento: Sip & Thrift Compartir este evento: Sip & Thrift",
  // a DATELESS card (title + street address, no date-expr, no venue line) → NOT indexed
  "MUJER BRILLANTE C/ de Cadis, 77",
  "Comprobar el precio de la entrada en el evento",
  "Guarda este evento: MUJER BRILLANTE Compartir este evento: MUJER BRILLANTE",
  // repeated card (the live page renders each 2–3×) — must de-dupe by title
  "Pub Crawl Valencia by Mad Party Crew hoy a las 22:30 + 2 más",
  "La Cola Del Pez",
  "Comprobar el precio de la entrada en el evento",
  // ONLINE section: no venue line + foreign tz → dropped
  "Online Events",
  "Fellowship Day 2026 | Virtual Workshops mañana a las 10:00 PDT",
  "Comprobar el precio de la entrada en el evento",
  "Guarda este evento: Fellowship Day 2026 | Virtual Workshops Compartir este evento: Fellowship Day 2026 | Virtual Workshops",
  "Underwater Wildlife Photography Essentials with Evie Wilderness | Online Tue, Sep 1, 6:30 PM GMT+10",
  "Comprobar el precio de la entrada en el evento",
  "The RECESS CRUISE on Labor Day Weekend 2026! Sat, Sep 5, 4:00 PM EDT",
  "Comprobar el precio de la entrada en el evento",
].join("\n");

test("buildSnapshotIndex: SPANISH marker + '+ N más' trailer (locale regression)", () => {
  const idx = buildSnapshotIndex(ES_SNAPSHOT_TEXT);

  const pub = idx.get("pub crawl valencia by mad party crew");
  assert.ok(pub, "Spanish-marker card indexed");
  assert.equal(pub.dateExpr, "hoy a las 22:30"); // "+ 2 más" trimmed
  assert.equal(pub.venue, "La Cola Del Pez");
  assert.equal(pub.online, false);

  const frank = idx.get("frank hurricane (ee.uu)");
  assert.ok(frank, "EN-absolute date inside the ES page still indexed");
  assert.equal(frank.dateExpr, "Thu, Sep 3, 8:00 PM");
  assert.equal(frank.venue, "Bar Centro Excursionista");

  // Dateless address card → no date token → not indexed (second pass may emit undated).
  assert.equal(idx.get("mujer brillante c/ de cadis, 77"), undefined);
  assert.equal(idx.get("mujer brillante"), undefined);

  // Online cards flagged (foreign tz, no venue) — including GMT+10.
  assert.equal(idx.get("fellowship day 2026 | virtual workshops")?.online, true);
  assert.equal(
    idx.get("underwater wildlife photography essentials with evie wilderness | online")?.online,
    true,
  );
  assert.equal(idx.get("the recess cruise on labor day weekend 2026!")?.online, true);
});

test("buildEventbriteEvents: Spanish snapshot emits dated Valencia cards, drops online", () => {
  const rows = [
    {
      id: 2038,
      source_key: EVENTBRITE_SOURCE_KEY,
      item_type: "snapshot",
      title: "Eventos, calendario y entradas en Valencia, España | Eventbrite",
      url: "https://www.eventbrite.es/d/spain--valencia/events/",
      raw_text: ES_SNAPSHOT_TEXT,
      raw_json: JSON.stringify({ kind: "page_snapshot" }),
      first_seen: "2026-08-07T05:33:00Z", // real scrape day: FRIDAY 2026-08-07
    },
    linkCard(2040, "Pub Crawl Valencia by Mad Party Crew", "https://www.eventbrite.es/e/entradas-pub-crawl-valencia-by-mad-party-crew-1777986297879?aff=x"),
  ];
  const events = buildEventbriteEvents(rows, new Date(2026, 7, 8)); // run a day later
  const byTitle = Object.fromEntries(events.map((e) => [e.draft.title, e.draft]));

  assert.deepEqual(Object.keys(byTitle).sort(), [
    "FRANK HURRICANE (EE.UU)",
    "Jazz at Loom. Every Sunday jazz Jam session.",
    "Pub Crawl Valencia by Mad Party Crew",
    "Sip & Thrift",
  ]);

  // hoy → the SCRAPE Friday, not the run day.
  assert.equal(byTitle["Pub Crawl Valencia by Mad Party Crew"].start_date, "2026-08-07");
  assert.equal(byTitle["Pub Crawl Valencia by Mad Party Crew"].start_time, "22:30");
  assert.ok(/\/e\//.test(byTitle["Pub Crawl Valencia by Mad Party Crew"].url), "/e/ link attached");
  // domingo → next Sunday on/after Fri 2026-08-07 = 2026-08-09.
  assert.equal(byTitle["Jazz at Loom. Every Sunday jazz Jam session."].start_date, "2026-08-09");
  // mañana → Sat 2026-08-08.
  assert.equal(byTitle["Sip & Thrift"].start_date, "2026-08-08");
  // English absolute inside the Spanish page.
  assert.equal(byTitle["FRANK HURRICANE (EE.UU)"].start_date, "2026-09-03");
  assert.equal(byTitle["FRANK HURRICANE (EE.UU)"].start_time, "20:00");
});

// ============ T154: a batch with SEVERAL snapshots — each anchors to ITS OWN scrape date ============

test("buildEventbriteEvents: multi-snapshot batch — per-snapshot refDate, title+date de-dupe", () => {
  const esSnap = {
    id: 2038,
    source_key: EVENTBRITE_SOURCE_KEY,
    item_type: "snapshot",
    title: "Eventos | Eventbrite",
    url: "https://www.eventbrite.es/d/spain--valencia/events/",
    raw_text: ES_SNAPSHOT_TEXT,
    raw_json: JSON.stringify({ kind: "page_snapshot" }),
    first_seen: "2026-08-07T05:33:00Z", // Friday
  };
  const enSnap = {
    id: 247,
    source_key: EVENTBRITE_SOURCE_KEY,
    item_type: "snapshot",
    title: "Eventos | Eventbrite",
    url: "https://www.eventbrite.es/d/spain--valencia/events/",
    raw_text: SNAPSHOT_TEXT, // the English 2026-06-20 snapshot fixture
    raw_json: JSON.stringify({ kind: "page_snapshot" }),
    first_seen: "2026-06-20T22:28:58Z", // Saturday
  };
  const events = buildEventbriteEvents([esSnap, enSnap], new Date(2026, 7, 8));

  // "Pub Crawl … hoy" appears in BOTH snapshots → TWO events, each on its own scrape day.
  const pub = events.filter((e) => e.draft.title === "Pub Crawl Valencia by Mad Party Crew");
  assert.deepEqual(pub.map((e) => e.draft.start_date).sort(), ["2026-06-20", "2026-08-07"]);
  // …and each keeps its own snapshot's venue (newest first).
  assert.equal(pub.find((e) => e.draft.start_date === "2026-08-07").draft.venue_name, "La Cola Del Pez");
  assert.equal(pub.find((e) => e.draft.start_date === "2026-06-20").draft.venue_name, "Bear Club - Valencia");

  // The OLD snapshot's cards were NOT lost (pre-fix: only the first-found snapshot ran).
  const coral = events.find((e) => e.draft.title === "Música coral en directo");
  assert.ok(coral, "older snapshot's card still emitted");
  assert.equal(coral.draft.start_date, "2026-06-27");

  // Weekday cards anchor to EACH snapshot's own scrape day: "Jazz … domingo/mañana".
  const jazz = events.filter((e) => e.draft.title === "Jazz at Loom. Every Sunday jazz Jam session.");
  assert.deepEqual(jazz.map((e) => e.draft.start_date).sort(), ["2026-06-21", "2026-08-09"]);
  for (const j of jazz) assert.equal(weekday(j.draft.start_date), "Sun");

  // No online card leaked from either snapshot.
  for (const e of events) {
    assert.ok(!/fellowship|recess cruise|underwater|career fair|pda for educators/i.test(e.draft.title));
  }
});

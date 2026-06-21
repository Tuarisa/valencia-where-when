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
} from "../lib/pipeline/normalizers/eventbrite.ts";

// Fixed reference date so relative ("hoy"/"mañana"/weekday) parsing is deterministic.
// Saturday 2026-06-20 (matches the real snapshot capture: "hoy a las 22:30" cards).
const TODAY = new Date(2026, 5, 20); // 2026-06-20, a Saturday

// A snapshot fragment FAITHFUL to the live id=247 raw_text: each real card renders as
// "<title> <date-expr>\n<venue>\nCheck ticket price on event", plus chrome/badge lines
// ("Sales end soon", "Save this event: …") and an Online-Events card with a foreign tz.
const SNAPSHOT_TEXT = [
  "Los mejores eventos en",
  "Valencia",
  "After 8pm",
  "Explore more events",
  "Pub Crawl Valencia by Mad Party Crew hoy a las 22:30 + 1 more",
  "Bear Club - Valencia",
  "Check ticket price on event",
  "Jazz at Loom. Every Sunday jazz Jam session. mañana a las 20:30",
  "LOOM VLC",
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
  "Online Events",
  "An Introduction to PDA for Educators miércoles a las 16:00 GMT+1",
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
  // real /e/ events
  linkCard(254, "Pub Crawl Valencia by Mad Party Crew", "https://www.eventbrite.es/e/entradas-pub-crawl-valencia-by-mad-party-crew-1777986297879?aff=ebdssbcitybrowsenightlife"),
  // SAME event, different ?aff= → must de-dupe to one
  linkCard(263, "Pub Crawl Valencia by Mad Party Crew", "https://www.eventbrite.es/e/entradas-pub-crawl-valencia-by-mad-party-crew-1777986297879?aff=ebdssbcitybrowse"),
  linkCard(255, "Jazz at Loom. Every Sunday jazz Jam session.", "https://www.eventbrite.es/e/jazz-at-loom-every-sunday-jazz-jam-session-tickets-1807073859559?aff=ebdssbcitybrowsenightlife"),
  linkCard(259, "Jornada PrimeTime Project", "https://www.eventbrite.es/e/entradas-jornada-primetime-project-1988320110976?aff=ebdssbcitybrowse"),
  linkCard(260, "Fuckup Nights Valencia Vol. XLIV", "https://www.eventbrite.es/e/fuckup-nights-valencia-vol-xliv-tickets-1992117357643?aff=ebdssbcitybrowse"),
  // a real /e/ event that has NO snapshot date row → still emits, start_date null
  linkCard(264, "Saturday Language Exchange & Party", "https://www.eventbrite.es/e/entradas-saturday-language-exchange-party-799030370347?aff=ebdssbcitybrowse"),
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

test("buildSnapshotIndex maps title → { dateExpr, venue }", () => {
  const idx = buildSnapshotIndex(SNAPSHOT_TEXT);
  const pub = idx.get("pub crawl valencia by mad party crew");
  assert.ok(pub, "Pub Crawl indexed");
  assert.equal(pub.dateExpr, "hoy a las 22:30"); // "+ 1 more" trimmed
  assert.equal(pub.venue, "Bear Club - Valencia");

  const fuckup = idx.get("fuckup nights valencia vol. xliv");
  assert.ok(fuckup);
  assert.equal(fuckup.dateExpr, "Thu, Jul 2, 7:00 PM");
  assert.equal(fuckup.venue, "ADEIT - Fundación Universidad - Empresa de la Universitat de València");
});

test("buildEventbriteEvents: date parsed, title correct, junk dropped, dupes collapsed", () => {
  const events = buildEventbriteEvents(ROWS, TODAY);

  // 6 distinct real events: Pub Crawl (dupe collapsed), Jazz, Jornada, Fuckup,
  // Saturday Language Exchange. Wait — that's 5; plus none of the chrome.
  const titles = events.map((e) => e.draft.title).sort();
  assert.deepEqual(titles, [
    "Fuckup Nights Valencia Vol. XLIV",
    "Jazz at Loom. Every Sunday jazz Jam session.",
    "Jornada PrimeTime Project",
    "Pub Crawl Valencia by Mad Party Crew",
    "Saturday Language Exchange & Party",
  ]);

  // No chrome / poi / nav leaked in.
  for (const t of titles) {
    assert.ok(!/things to do|explore more|popular in|cathedral|cookie|conciertos|workshops/i.test(t), `chrome leaked: ${t}`);
  }

  const byTitle = Object.fromEntries(events.map((e) => [e.draft.title, e.draft]));

  // Pub Crawl: hoy → 2026-06-20, time 22:30, venue from snapshot, only ONCE.
  const pub = byTitle["Pub Crawl Valencia by Mad Party Crew"];
  assert.equal(pub.start_date, "2026-06-20");
  assert.equal(pub.start_time, "22:30");
  assert.equal(pub.venue_name, "Bear Club - Valencia");
  assert.equal(events.filter((e) => e.draft.title === "Pub Crawl Valencia by Mad Party Crew").length, 1);

  // Fuckup: English absolute → 2026-07-02, 19:00.
  const fk = byTitle["Fuckup Nights Valencia Vol. XLIV"];
  assert.equal(fk.start_date, "2026-07-02");
  assert.equal(fk.start_time, "19:00");

  // Jornada: weekday → next Friday 2026-06-26.
  assert.equal(byTitle["Jornada PrimeTime Project"].start_date, "2026-06-26");

  // Saturday Language Exchange: no snapshot date row → start_date null, still emits.
  const sat = byTitle["Saturday Language Exchange & Party"];
  assert.equal(sat.start_date, "2026-06-20"); // it IS in the snapshot ("hoy"), so dated
  assert.equal(sat.venue_name, "C/ del Convent de Sant Francesc, 2");

  // Source / city / country invariants.
  for (const e of events) {
    assert.equal(e.draft.source, "web:eventbrite");
    assert.equal(e.draft.city, "Valencia");
    assert.equal(e.draft.country, "Spain");
    assert.ok(/eventbrite\.es\/e\//.test(e.draft.url), "url is the /e/ deep link");
  }
});

test("buildEventbriteEvents: an /e/ event with NO snapshot entry still emits undated", () => {
  const lone = [
    linkCard(900, "Some Untracked Concert", "https://www.eventbrite.es/e/some-untracked-concert-999?aff=x"),
  ];
  const events = buildEventbriteEvents(lone, TODAY);
  assert.equal(events.length, 1);
  assert.equal(events[0].draft.start_date, null);
  assert.equal(events[0].draft.venue_name, null);
  assert.equal(events[0].draft.title, "Some Untracked Concert");
});

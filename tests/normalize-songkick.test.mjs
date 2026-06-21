import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SONGKICK_SOURCE_KEY,
  isDateRow,
  parseSongkickDateRow,
  isSongkickEventUrl,
  songkickTitle,
  buildSongkickEvents,
  normalizeSongkick,
} from "../lib/pipeline/normalizers/songkick.ts";

// Fixtures faithful to the REAL live rows (web:songkick, item_type='mixed'):
// a single gig is split across a TITLE row and a DATE row that share `url`.
const link = (id, title, url) => ({
  id,
  source_key: SONGKICK_SOURCE_KEY,
  item_type: "mixed",
  title,
  raw_text: title,
  url,
  raw_json: JSON.stringify({ kind: "link_card", source_page: "https://www.songkick.com/metro-areas/28802-spain-valencia" }),
});

const TODAY = new Date("2026-06-21T00:00:00Z");

test("source key matches sources.json", () => {
  assert.equal(SONGKICK_SOURCE_KEY, "web:songkick");
});

test("isDateRow detects the '<Weekday> <DD> <Mon> <YYYY>' prefix", () => {
  assert.equal(isDateRow("Tue 17 Nov 2026 Sala Moon Valencia, Spain"), true);
  assert.equal(isDateRow("Razorlight Sala Moon"), false);
  assert.equal(isDateRow(""), false);
  assert.equal(isDateRow(null), false);
});

test("parseSongkickDateRow extracts ISO date + venue (explicit year, no inference)", () => {
  const a = parseSongkickDateRow("Tue 17 Nov 2026 Sala Moon Valencia, Spain");
  assert.equal(a.start, "2026-11-17");
  assert.equal(a.venue, "Sala Moon");

  const b = parseSongkickDateRow("Sun 31 Jan 2027 Roig Arena Valencia, Spain");
  assert.equal(b.start, "2027-01-31");
  assert.equal(b.venue, "Roig Arena");

  // beach-town city tail is trimmed off the venue
  const c = parseSongkickDateRow("Fri 24 Jul 2026 Zevra Festival 2026 Cullera Beach, Spain");
  assert.equal(c.start, "2026-07-24");
  assert.ok(/Zevra Festival 2026/.test(c.venue));

  // non-date row → nulls
  assert.deepEqual(parseSongkickDateRow("Razorlight Sala Moon"), { start: null, venue: null });
});

test("isSongkickEventUrl keeps concerts/festivals, drops chrome", () => {
  assert.equal(isSongkickEventUrl("https://www.songkick.com/concerts/43275058-razorlight-at-sala-moon"), true);
  assert.equal(isSongkickEventUrl("https://www.songkick.com/festivals/3422882-zevra/id/43259478-zevra-festival-2026"), true);
  assert.equal(isSongkickEventUrl("https://www.songkick.com/venues/94077-plaza-de-toros-de-valencia"), false);
  assert.equal(isSongkickEventUrl("https://www.songkick.com/artists/21043-triangulo-de-amor-bizarro"), false);
  assert.equal(isSongkickEventUrl("https://www.songkick.com/leaderboards/popular_artists"), false);
  assert.equal(isSongkickEventUrl("https://tourbox.songkick.com/?x=1"), false);
  assert.equal(isSongkickEventUrl("https://accounts.songkick.com/session/new"), false);
  assert.equal(isSongkickEventUrl(null), false);
});

test("songkickTitle strips a trailing venue suffix from a concert title", () => {
  assert.equal(songkickTitle("Razorlight Sala Moon", "Sala Moon"), "Razorlight");
  // no venue parsed → keep whole title
  assert.equal(songkickTitle("Razorlight Sala Moon", null), "Razorlight Sala Moon");
});

test("buildSongkickEvents pairs title + date rows by url and dates the event", () => {
  const rows = [
    // snapshot index page → dropped
    { id: 1, source_key: SONGKICK_SOURCE_KEY, item_type: "snapshot", title: "Valencia Concerts – Songkick",
      raw_text: "…", url: "https://www.songkick.com/metro-areas/28802-spain-valencia",
      raw_json: JSON.stringify({ kind: "page_snapshot", meta: {} }) },
    // a concert: title row + date row, same url
    link(2, "Razorlight Sala Moon", "https://www.songkick.com/concerts/43275058-razorlight-at-sala-moon"),
    link(3, "Tue 17 Nov 2026 Sala Moon Valencia, Spain", "https://www.songkick.com/concerts/43275058-razorlight-at-sala-moon"),
    // a festival with lineup title row + date row (lineup title is longer → wins)
    link(4, "Maria Becerra Roig Arena", "https://www.songkick.com/festivals/3790334-reve-fest/id/43260061-reve-fest-2026"),
    link(5, "Reve Fest 2026 Maria Becerra, RVFV, Kidd Voodoo, La Zowi, l0rna, and C Marí", "https://www.songkick.com/festivals/3790334-reve-fest/id/43260061-reve-fest-2026"),
    link(6, "Thu 16 Jul 2026 Reve Fest 2026 Valencia, Spain", "https://www.songkick.com/festivals/3790334-reve-fest/id/43260061-reve-fest-2026"),
    // chrome rows → dropped
    link(7, "Most popular artists worldwide", "https://www.songkick.com/leaderboards/popular_artists"),
    link(8, "Sign up as an artist", "https://tourbox.songkick.com/?utm_source=songkick.com"),
    link(9, "Plaza de Toros de Valencia", "https://www.songkick.com/venues/94077-plaza-de-toros-de-valencia"),
    link(10, "Community guidelines", "https://www.songkick.com/info/guidelines"),
  ];

  const out = buildSongkickEvents(rows, TODAY);
  // exactly TWO events (one concert, one festival); all chrome dropped
  assert.equal(out.length, 2);

  const byUrl = Object.fromEntries(out.map((o) => [o.draft.url, o.draft]));

  const razor = byUrl["https://www.songkick.com/concerts/43275058-razorlight-at-sala-moon"];
  assert.ok(razor, "razorlight event present");
  assert.equal(razor.title, "Razorlight");
  assert.equal(razor.start_date, "2026-11-17");
  assert.equal(razor.venue_name, "Sala Moon");
  assert.equal(razor.city, "Valencia");
  assert.equal(razor.country, "Spain");
  assert.equal(razor.source, "web:songkick");

  const reve = byUrl["https://www.songkick.com/festivals/3790334-reve-fest/id/43260061-reve-fest-2026"];
  assert.ok(reve, "reve fest event present");
  // longest non-date title wins (the lineup row)
  assert.ok(reve.title.startsWith("Reve Fest 2026"));
  assert.equal(reve.start_date, "2026-07-16");
});

test("festival without a date row emits start_date=null (no guess from slug year)", () => {
  const rows = [
    link(1, "Big Sound Valencia 2026 Manuel Turizo, Rels B, Juan Magan", "https://www.songkick.com/festivals/3775073-big-sound-valencia/id/43056793-big-sound-valencia-2026"),
  ];
  const out = buildSongkickEvents(rows, TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].draft.start_date, null, "bare slug year is NOT a date");
  assert.ok(out[0].draft.title.startsWith("Big Sound Valencia 2026"));
});

test("normalizeSongkick: idempotent upsert + append-only marking via injected exec", async () => {
  // In-memory fake: capture INSERTs, simulate ON CONFLICT, record marked rows.
  const events = new Map(); // dedup_hash -> draft
  const marked = [];
  let firstInsert = true;

  const fakeRows = [
    link(2, "Razorlight Sala Moon", "https://www.songkick.com/concerts/43275058-razorlight-at-sala-moon"),
    link(3, "Tue 17 Nov 2026 Sala Moon Valencia, Spain", "https://www.songkick.com/concerts/43275058-razorlight-at-sala-moon"),
    link(7, "Most popular artists worldwide", "https://www.songkick.com/leaderboards/popular_artists"),
  ];

  const exec = async (strings, ...vals) => {
    const q = strings.join("?");
    if (/SELECT \* FROM source_items/.test(q)) return fakeRows;
    if (/INSERT INTO events/.test(q)) {
      const inserted = firstInsert;
      firstInsert = false;
      return [{ inserted }];
    }
    if (/UPDATE source_items/.test(q)) {
      marked.push(vals);
      return [];
    }
    return [];
  };

  const res = await normalizeSongkick({ exec });
  // 3 raw rows processed (incl. the chrome leaderboards row), 1 event produced
  assert.equal(res.processed, 3);
  assert.equal(res.created + res.updated, 1);
  // every processed raw row is marked normalized (append-only)
  assert.equal(marked.length, 3);
});

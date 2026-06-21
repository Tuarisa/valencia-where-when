import { test } from "node:test";
import assert from "node:assert/strict";

import {
  titleSignature,
  significantTokens,
  titlesContain,
  containmentGroups,
  tierBaseTitle,
  areTierVariants,
  tierVariantGroups,
} from "../lib/pipeline/dedup.ts";

// Regression coverage for the QA-found data-quality bugs (imports the REAL dedup.ts):
//   Bug 1 — cross-source duplicate missed because one source's title carries a leading
//           date/price NOISE prefix + a trailing venue (valenciarusa "Oxxxymiron").
//   Bug 2 — same-source ticket-TIER variants ("Rod Stewart" + "Rod Stewart | Paquetes VIP").

// ===================== Bug 1: title signature drops date/price noise =====================

test("titleSignature: drops pure-numeric date/price tokens", () => {
  // The "28"/"69"/"2" from a "ИЮН 28 2 сеансов от 69 €" prefix must not enter the signature.
  const sig = titleSignature("28 69 2 Oxxxymiron");
  assert.ok(!sig.split("-").some((t) => /^\d+$/.test(t)), "no bare-numeric tokens in signature");
  assert.ok(sig.includes("oxxxymiron"));
});

test("titleSignature: drops boilerplate tokens (сеансов/от/евро/tour/vip)", () => {
  const sig = titleSignature("Slava seansov ot evro tour vip");
  // every boilerplate word is a stopword now → signature collapses to the artist name.
  assert.equal(sig, "slava");
});

test("significantTokens: degenerate title → empty array", () => {
  assert.deepEqual(significantTokens("«»"), []);
  assert.deepEqual(significantTokens(""), []);
});

test("titlesContain: noisy valenciarusa title contains the clean worldafisha one (Oxxxymiron)", () => {
  const clean = "Oxxxymiron - Oxxxymiron Tour 2026 «Национальность: нет»";
  // valenciarusa core (noise prefix stripped by the normalizer, trailing venue still present)
  const noisy = "Oxxxymiron в Валенсии: гастроли «Национальность: нет» в Roig Arena Auditorio Roig Arena";
  assert.equal(titlesContain(clean, noisy), true);
  assert.equal(titlesContain(noisy, clean), true); // symmetric
});

test("titlesContain: same artist with extra venue/location tokens still matches", () => {
  assert.equal(
    titlesContain("Слава Комиссаренко", "Слава Комиссаренко в Валенсии: стендап 21 июня 2026 Roig Arena"),
    true,
  );
  assert.equal(
    titlesContain("Руслан Белый «Иммиграции»", "Руслан Белый в Валенсии 13 сентября: «Иммиграции» в Teatro Flumen"),
    true,
  );
});

test("titlesContain: DIFFERENT artists at the same venue do NOT match", () => {
  assert.equal(
    titlesContain("Pet Shop Boys в Валенсии Roig Arena", "Слава Комиссаренко в Валенсии Roig Arena"),
    false,
  );
});

test("titlesContain: needs a STRONG (len>=4) shared token — short overlap alone won't merge", () => {
  // both share only the 2-char token "ab" → not strong → no match.
  assert.equal(titlesContain("ab Foo", "ab Bar baz"), false);
});

test("titlesContain: 3-way Komissarenko cluster matches via the distinctive surname (≥6)", () => {
  // None is a strict subset (each adds own venue/date/case tokens), but the distinctive
  // surname "komissarenko" is shared → same event.
  const a = "Слава Комиссаренко, Stand Up - Новая программа";
  const b = "Слава Комиссаренко в Валенсии: стендап 21 июня 2026 Roig Arena";
  const c = "Стендап-концерт Славы Комиссаренко в Валенсии";
  assert.equal(titlesContain(a, b), true);
  assert.equal(titlesContain(a, c), true);
  assert.equal(titlesContain(b, c), true);
});

test("titlesContain: GENERIC framing words (festival/spektakl) do NOT cause a merge", () => {
  // Two different festivals — sharing only the framing word "festival" must NOT merge.
  assert.equal(titlesContain("GRAN FIRA DE VALÈNCIA 2026 Festival", "Festival de Jazz de València"), false);
  // Two different plays sharing only "спектакль" → no merge.
  assert.equal(titlesContain("Дмитрий Назаров, Спектакль — Чёрт знает что", "Театр, по которому вы скучали — спектакль"), false);
});

test("containmentGroups: cross-source Oxxxymiron pair merges; different artists stay apart", () => {
  const events = [
    { id: 1, source: "web:worldafisha", city: "Valencia", start_date: "2026-06-28",
      title: "Oxxxymiron - Oxxxymiron Tour 2026 «Национальность: нет»" },
    { id: 2, source: "web:valenciarusa", city: "Valencia", start_date: "2026-06-28",
      title: "Oxxxymiron в Валенсии: гастроли «Национальность: нет» в Roig Arena Auditorio Roig Arena" },
    { id: 3, source: "web:worldafisha", city: "Valencia", start_date: "2026-06-28",
      title: "Pet Shop Boys в Валенсии: большой концерт" },
  ];
  const groups = containmentGroups(events);
  assert.equal(groups.length, 1, "exactly one merge group");
  const ids = groups[0].map((e) => e.id).sort();
  assert.deepEqual(ids, [1, 2]);
});

test("containmentGroups: SAME-source pair never merges (recurring/own series, not a dup)", () => {
  const events = [
    { id: 1, source: "web:worldafisha", city: "Valencia", start_date: "2026-06-28", title: "Oxxxymiron Tour" },
    { id: 2, source: "web:worldafisha", city: "Valencia", start_date: "2026-06-28", title: "Oxxxymiron Tour в Валенсии Roig Arena" },
  ];
  assert.equal(containmentGroups(events).length, 0);
});

test("containmentGroups: cross-source but DATES too far apart → no merge", () => {
  const events = [
    { id: 1, source: "web:a", city: "Valencia", start_date: "2026-06-01", title: "Oxxxymiron Tour" },
    { id: 2, source: "web:b", city: "Valencia", start_date: "2026-07-01", title: "Oxxxymiron Tour в Валенсии" },
  ];
  assert.equal(containmentGroups(events).length, 0);
});

test("containmentGroups: different CITY → no merge (geo guard)", () => {
  const events = [
    { id: 1, source: "web:a", city: "Valencia", start_date: "2026-06-28", title: "Oxxxymiron Tour" },
    { id: 2, source: "web:b", city: "Madrid", start_date: "2026-06-28", title: "Oxxxymiron Tour в Мадриде" },
  ];
  assert.equal(containmentGroups(events).length, 0);
});

// ===================== Bug 2: same-source ticket-tier variants =====================

test("tierBaseTitle: strips '| Paquetes VIP' suffix", () => {
  assert.equal(tierBaseTitle("Rod Stewart | Paquetes VIP"), "rod stewart");
  assert.equal(tierBaseTitle("Rod Stewart"), "rod stewart");
});

test("tierBaseTitle: strips Meet&Greet / Upgrade tiers", () => {
  assert.equal(tierBaseTitle("Yandel - Meet&Greet Upgrade"), "yandel");
  assert.equal(tierBaseTitle("La Reina del Flow — Meet and Greet"), "la reina del flow");
});

test("tierBaseTitle: does NOT chop a word that merely contains a keyword (no separator)", () => {
  // "Boxeo" contains "box" but has no separator before it → untouched.
  assert.equal(tierBaseTitle("Gala de Boxeo"), "gala de boxeo");
});

test("areTierVariants: Rod Stewart base + VIP at same source/date/time/venue → true", () => {
  const a = { source: "web:ticketmaster", start_date: "2026-06-30", start_time: "21:00",
    venue_name: "Valencia Roig Arena", title: "Rod Stewart" };
  const b = { source: "web:ticketmaster", start_date: "2026-06-30", start_time: "21:00",
    venue_name: "Valencia Roig Arena", title: "Rod Stewart | Paquetes VIP" };
  assert.equal(areTierVariants(a, b), true);
});

test("areTierVariants: different TIME → not a tier pair (distinct sessions)", () => {
  const a = { source: "web:ticketmaster", start_date: "2026-06-30", start_time: "21:00", venue_name: "X", title: "Rod Stewart" };
  const b = { source: "web:ticketmaster", start_date: "2026-06-30", start_time: "18:00", venue_name: "X", title: "Rod Stewart | Paquetes VIP" };
  assert.equal(areTierVariants(a, b), false);
});

test("areTierVariants: 00:00 PLACEHOLDER time matches a real time (La Reina del Flow Meet&Greet)", () => {
  const concert = { source: "web:ticketmaster", start_date: "2026-07-08", start_time: "21:00",
    venue_name: "Roig Arena", title: "La Reina del Flow" };
  const meetGreet = { source: "web:ticketmaster", start_date: "2026-07-08", start_time: "00:00",
    venue_name: "Roig Arena", title: "La Reina del Flow - Meet&Greet (entrada al concierto no incluida)" };
  assert.equal(areTierVariants(concert, meetGreet), true);
});

test("areTierVariants: two 00:00 placeholders → no real time signal → not collapsed", () => {
  const a = { source: "web:tm", start_date: "2026-01-01", start_time: "00:00", venue_name: "X", title: "A" };
  const b = { source: "web:tm", start_date: "2026-01-01", start_time: "00:00", venue_name: "X", title: "A | VIP" };
  assert.equal(areTierVariants(a, b), false);
});

test("areTierVariants: missing start_time on either side → not collapsed", () => {
  const a = { source: "web:ticketmaster", start_date: "2026-06-30", start_time: null, venue_name: "X", title: "Rod Stewart" };
  const b = { source: "web:ticketmaster", start_date: "2026-06-30", start_time: "21:00", venue_name: "X", title: "Rod Stewart | Paquetes VIP" };
  assert.equal(areTierVariants(a, b), false);
});

test("areTierVariants: different sources → handled by cross-source pass, NOT the tier rule", () => {
  const a = { source: "web:ticketmaster", start_date: "2026-06-30", start_time: "21:00", venue_name: "X", title: "Rod Stewart" };
  const b = { source: "web:fever", start_date: "2026-06-30", start_time: "21:00", venue_name: "X", title: "Rod Stewart | VIP" };
  assert.equal(areTierVariants(a, b), false);
});

test("areTierVariants: genuinely different shows (different base) at same venue/time → false", () => {
  const a = { source: "web:ticketmaster", start_date: "2026-06-30", start_time: "21:00", venue_name: "X", title: "Rod Stewart" };
  const b = { source: "web:ticketmaster", start_date: "2026-06-30", start_time: "21:00", venue_name: "X", title: "Coldplay | Paquetes VIP" };
  assert.equal(areTierVariants(a, b), false);
});

test("tierVariantGroups: collapses the Rod Stewart pair to one group", () => {
  const events = [
    { id: 25305, source: "web:ticketmaster", start_date: "2026-06-30", start_time: "21:00", venue_name: "Valencia Roig Arena", title: "Rod Stewart" },
    { id: 25299, source: "web:ticketmaster", start_date: "2026-06-30", start_time: "21:00", venue_name: "Valencia Roig Arena", title: "Rod Stewart | Paquetes VIP" },
    { id: 9, source: "web:ticketmaster", start_date: "2026-06-30", start_time: "21:00", venue_name: "Valencia Roig Arena", title: "Some Other Act" },
  ];
  const groups = tierVariantGroups(events);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((e) => e.id).sort((a, b) => a - b), [25299, 25305]);
});

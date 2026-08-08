import { test } from "node:test";
import assert from "node:assert/strict";

import { extractEventLinks } from "../lib/pipeline/ingest.ts";
import {
  normTitle,
  readEventLinks,
  matchEventLink,
  latestSnapshotRows,
} from "../lib/pipeline/normalizers/shared.ts";
import {
  LACOTORRA_SOURCE_KEY,
  buildLacotorraEvents,
} from "../lib/pipeline/normalizers/lacotorra.ts";
import { buildCacEvents } from "../lib/pipeline/normalizers/cac.ts";

// T190 — the event detail-page «Источник» link must point at the SPECIFIC event page,
// not the aggregator index. lacotorra.io/events + cac.es/<listing>/ both render each
// event as a CARD: an <a href="/detail"> wrapping an IMAGE (so the generic anchor pass
// drops it as empty/short text) + a separate TITLE element. `extractEventLinks` pairs
// each detail anchor with the first following title; the snapshot-driven normalizers
// then `matchEventLink(blockTitle, links)` → set the per-event url/source_url.

// ── extractEventLinks ─────────────────────────────────────────────────────────

// Faithful to the live lacotorra card markup: <a class="card-link" href="/events/slug">
// (image-only) then <p class="event-title">TITLE</p>.
const LACOTORRA_HTML = `
<div class="event-card">
  <a href="/events/shou-cirque-du-soleil-v-valensii" class="card-link"></a>
  <div class="event-thumb"><img src="/x.jpg" alt="Cirque"></div>
  <div class="event-descr">
    <p class="event-title">Шоу Cirque du Soleil в Валенсии</p>
    <p class="sub-text event-city">Валенсия</p>
  </div>
</div>
<div class="event-card">
  <a href="/events/koncert-bruno-marsa-v-madride" class="card-link"></a>
  <div class="event-thumb"><img src="/y.jpg" alt="Bruno"></div>
  <div class="event-descr">
    <p class="event-title">Концерт Бруно Марса в Мадриде</p>
  </div>
</div>
`;

test("extractEventLinks: lacotorra image-only cards → title→/events/slug map", () => {
  const links = extractEventLinks(LACOTORRA_HTML, "https://lacotorra.io/events");
  assert.equal(links.length, 2);
  const byTitle = Object.fromEntries(links.map((l) => [l.title, l.url]));
  assert.equal(
    byTitle["Шоу Cirque du Soleil в Валенсии"],
    "https://lacotorra.io/events/shou-cirque-du-soleil-v-valensii",
  );
  assert.equal(
    byTitle["Концерт Бруно Марса в Мадриде"],
    "https://lacotorra.io/events/koncert-bruno-marsa-v-madride",
  );
});

// Faithful to the cac.es (Elementor) card markup: featured-image anchor then an <h-tag>
// title further down in the same loop item.
const CAC_HTML = `
<div class="elementor-post">
  <a href="https://cac.es/exposiciones/exposicion-park-eun-sun-valencia/" target="_blank">
    <img src="/expo.jpg" alt="expo-Park-Eun-Sun-cs">
  </a>
  <div class="elementor-widget-container">
    <h3 class="elementor-heading-title">PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA</h3>
  </div>
</div>
<div class="elementor-post">
  <a href="https://cac.es/exposiciones/exposicion-memoria-museu-ciencies/" target="_blank">
    <img src="/mem.jpg" alt="Memoria">
  </a>
  <div class="elementor-widget-container">
    <h3 class="elementor-heading-title">EXPOSICIÓN MEMORIA</h3>
  </div>
</div>
`;

test("extractEventLinks: cac Elementor cards → title→detail-page map", () => {
  const links = extractEventLinks(CAC_HTML, "https://cac.es/exposiciones/");
  const byTitle = Object.fromEntries(links.map((l) => [l.title, l.url]));
  assert.equal(
    byTitle["PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA"],
    "https://cac.es/exposiciones/exposicion-park-eun-sun-valencia/",
  );
  assert.equal(
    byTitle["EXPOSICIÓN MEMORIA"],
    "https://cac.es/exposiciones/exposicion-memoria-museu-ciencies/",
  );
});

// T203 — faithful to the live visitvalencia card markup (cut from the live listing,
// 2026-08-08): the h3 heading sits in `card__body` and the detail anchor is the LAST
// element of the card, wrapping the title text itself (`visually-hidden card__link`).
// The pre-fix «first title AFTER the anchor» window paired every title with the
// NEIGHBOURING card's URL (verified on live source_items row 1807).
const VISITVALENCIA_HTML = `
<div class="col--card col-lg-6">
<div  data-history-node-id="86802" about="/en/events-valencia/sonido-de-valencia-festival" class="card card--horizontal card--shadow card--event card--tile">
    <div  class="card__top">
      <div class="field field--name-field-teaser-image field--type-entity-reference field--label-hidden field__item"><div>
        <div class="field field--name-field-media-image field--type-image field--label-hidden field__item">    <picture>
          <source srcset="/sites/default/files/styles/filtered_portrait_tablet/public/media/media-images/images/sonido.jpg.webp?itok=x 1x" media="all and (min-width: 992px)" type="image/webp" width="745" height="425"/>
          <img loading="lazy" width="355" height="265" src="/sites/default/files/styles/filtered_teaser/public/media/media-images/images/sonido.jpg.webp?itok=x" alt="Sonido Valencia" typeof="foaf:Image" />
        </picture>
        </div>
      </div></div>
    </div>
    <div  class="card__body">
      <div>
<h3   class="card__heading card__heading--link card__heading--sub">
      “Sonido de Valencia” Festival
    </h3>
      </div>
      <div  class="card__date text--small">
      </div>
    </div>
    <a class="visually-hidden card__link" href="/en/events-valencia/sonido-de-valencia-festival">“Sonido de Valencia” Festival </a>
</div>
</div>
<div class="col--card col-lg-6">
<div  data-history-node-id="90076" about="/en/events-valencia/descanso-entrevinas-getaway-bodegas-nodus" class="card card--horizontal card--shadow card--event card--tile">
    <div  class="card__top">
      <div class="field field--name-field-teaser-image field--type-entity-reference field--label-hidden field__item"><div>
        <div class="field field--name-field-media-image field--type-image field--label-hidden field__item">    <picture>
          <source srcset="/sites/default/files/styles/filtered_portrait_tablet/public/media/media-images/images/alegal.jpg.webp?itok=y 1x" media="all and (min-width: 992px)" type="image/webp" width="745" height="425"/>
          <img loading="lazy" width="355" height="265" src="/sites/default/files/styles/filtered_teaser/public/media/media-images/images/alegal.jpg.webp?itok=y" alt="Viernes y sábados en el Restaurante Alegal de València" typeof="foaf:Image" />
        </picture>
        </div>
      </div></div>
    </div>
    <div  class="card__body">
      <div>
<h3   class="card__heading card__heading--link card__heading--sub">
      "Descanso Entreviñas" Getaway by Bodegas Nodus
    </h3>
      </div>
      <div  class="card__date text--small">
      </div>
    </div>
    <a class="visually-hidden card__link" href="/en/events-valencia/descanso-entrevinas-getaway-bodegas-nodus">&quot;Descanso Entreviñas&quot; Getaway by Bodegas Nodus</a>
</div>
</div>
`;

test("extractEventLinks: visitvalencia title-wrapping card__link anchors — no off-by-one (T203)", () => {
  const links = extractEventLinks(
    VISITVALENCIA_HTML,
    "https://www.visitvalencia.com/en/events-valencia",
  );
  assert.equal(links.length, 2);
  const byTitle = Object.fromEntries(links.map((l) => [l.title, l.url]));
  // pre-fix this paired «Descanso…» (card 2's h3) with card 1's URL and dropped card 2
  assert.equal(
    byTitle["“Sonido de Valencia” Festival"],
    "https://www.visitvalencia.com/en/events-valencia/sonido-de-valencia-festival",
  );
  assert.equal(
    byTitle['"Descanso Entreviñas" Getaway by Bodegas Nodus'],
    "https://www.visitvalencia.com/en/events-valencia/descanso-entrevinas-getaway-bodegas-nodus",
  );
});

// T203 — faithful to the live ticketbest.eu compilation-card markup: the anchor wraps
// an `<h1 class='category_title'>` PLUS an event-count span («6 üritust»). The marked-up
// title inside the anchor must win over the anchor's whole inner text (no counter glued
// onto the title — the stored DB row 2253 pairs stay byte-identical).
const TICKETBEST_HTML = `
<div class='categories'>
<a class="category" href="/compilations/muzyka-bridzherton-kontsertnyi-tur"><img class="category_image" src="/uploads/compilation/image/8/crop_Bridgerton_600%D1%85150.jpg" />
<div class='category_text'>
<h1 class='category_title'>Bridgertoni muusika: kontserttuur</h1>
<span class='category_count'>
6
üritust
</span>
</div>
</a><a class="category" href="/compilations/muzyka-ennio-morrikone-kontsertnyi-tur"><img class="category_image" src="/uploads/compilation/image/9/crop_Ennio-Morricone-600%D1%85150.jpg" />
<div class='category_text'>
<h1 class='category_title'>Ennio Morricone muusika: kontserttuur</h1>
<span class='category_count'>
7
üritust
</span>
</div>
</a>
</div>
`;

test("extractEventLinks: ticketbest anchors wrapping a title element — inner title wins over whole text", () => {
  const links = extractEventLinks(TICKETBEST_HTML, "https://www.ticketbest.eu");
  assert.equal(links.length, 2);
  const byTitle = Object.fromEntries(links.map((l) => [l.title, l.url]));
  assert.equal(
    byTitle["Bridgertoni muusika: kontserttuur"],
    "https://www.ticketbest.eu/compilations/muzyka-bridzherton-kontsertnyi-tur",
  );
  assert.equal(
    byTitle["Ennio Morricone muusika: kontserttuur"],
    "https://www.ticketbest.eu/compilations/muzyka-ennio-morrikone-kontsertnyi-tur",
  );
});

test("extractEventLinks: ignores chrome anchors (index/category/section)", () => {
  const html = `
    <a href="/events">Все события</a>
    <a href="/events?category=koncerty">Концерты</a>
    <a href="https://cac.es/agenda/">Agenda</a>
    <a href="/privacy-policy">Política</a>
  `;
  assert.equal(extractEventLinks(html, "https://lacotorra.io/events").length, 0);
});

// ── normTitle / readEventLinks / matchEventLink ────────────────────────────────

test("normTitle: folds case/diacritics/punctuation, keeps Cyrillic + digits", () => {
  assert.equal(normTitle("  EXPOSICIÓN «MEMORIA»  "), "exposicion memoria");
  assert.equal(normTitle("Шоу Cirque du Soleil!"), "шоу cirque du soleil");
});

test("readEventLinks: reads the array off parsed raw_json, [] when absent/malformed", () => {
  assert.deepEqual(
    readEventLinks({ event_links: [{ title: "A", url: "u" }, { title: "B", url: "v" }] }),
    [{ title: "A", url: "u" }, { title: "B", url: "v" }],
  );
  assert.deepEqual(readEventLinks({ kind: "page_snapshot" }), []);
  assert.deepEqual(readEventLinks(null), []);
  // drops malformed entries (missing url/title)
  assert.deepEqual(readEventLinks({ event_links: [{ title: "A" }, { url: "v" }, 5] }), []);
});

const LINKS = [
  { title: "Шоу Cirque du Soleil в Валенсии", url: "https://lacotorra.io/events/shou-cirque-du-soleil-v-valensii" },
  { title: "Концерт Бруно Марса в Мадриде", url: "https://lacotorra.io/events/koncert-bruno-marsa-v-madride" },
  { title: "📢NUEVA EXPOSICIÓN. PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA", url: "https://cac.es/exposiciones/exposicion-park-eun-sun-valencia/" },
];

test("matchEventLink: exact normalized-title match (lacotorra)", () => {
  assert.equal(
    matchEventLink("Шоу Cirque du Soleil в Валенсии", LINKS),
    "https://lacotorra.io/events/shou-cirque-du-soleil-v-valensii",
  );
});

test("matchEventLink: containment when the card heading carries an extra prefix (cac)", () => {
  // The cac block title is the bare "PARK EUN SUN…"; the card heading has a "📢NUEVA
  // EXPOSICIÓN. " prefix — substantial containment still resolves it.
  assert.equal(
    matchEventLink("PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA", LINKS),
    "https://cac.es/exposiciones/exposicion-park-eun-sun-valencia/",
  );
});

test("matchEventLink: returns null when nothing matches (no wrong link)", () => {
  assert.equal(matchEventLink("Совершенно другое событие XYZ", LINKS), null);
  assert.equal(matchEventLink("", LINKS), null);
  assert.equal(matchEventLink("anything", []), null);
});

// ── latestSnapshotRows ────────────────────────────────────────────────────────

test("latestSnapshotRows: keeps only the freshest snapshot per source, all link_cards", () => {
  const snap = (id, sk, links) => ({
    id,
    source_key: sk,
    raw_json: JSON.stringify({ kind: "page_snapshot", event_links: links }),
  });
  const card = (id, sk) => ({ id, source_key: sk, raw_json: JSON.stringify({ kind: "link_card" }) });
  const rows = [
    snap(470, "web:lacotorra", []), // stale, no links
    card(471, "web:lacotorra"),
    snap(1023, "web:lacotorra", [{ title: "A", url: "u" }]), // freshest
    snap(600, "web:cac_agenda", []), // a different source's only snapshot
  ];
  const kept = latestSnapshotRows(rows);
  const ids = kept.map((r) => r.id).sort((a, b) => a - b);
  // dropped the stale 470; kept 471 (card), 600 (sole cac snapshot), 1023 (freshest lacotorra)
  assert.deepEqual(ids, [471, 600, 1023]);
});

// ── normalizer integration: per-event url/source_url ──────────────────────────

const REF = new Date("2026-06-21");

test("buildLacotorraEvents: sets per-event url+source_url from event_links", () => {
  const snapshot = {
    id: 470,
    source_key: LACOTORRA_SOURCE_KEY,
    url: "https://lacotorra.io/events",
    raw_text: [
      "Мероприятия Валенсии",
      "Все",
      // one block: Title / Description / Date / Venue  (no separate city line)
      "Шоу Cirque du Soleil в Валенсии",
      "Большое цирковое шоу приезжает в город…",
      "9 Jun 2026, 10:00 - 5 Aug 2026, 12:00",
      "Roig Arena",
    ].join("\n"),
    raw_json: JSON.stringify({
      kind: "page_snapshot",
      meta: {},
      event_links: [
        {
          title: "Шоу Cirque du Soleil в Валенсии",
          url: "https://lacotorra.io/events/shou-cirque-du-soleil-v-valensii",
        },
      ],
    }),
  };
  const events = buildLacotorraEvents([snapshot], REF);
  assert.equal(events.length, 1);
  const d = events[0].draft;
  assert.equal(d.url, "https://lacotorra.io/events/shou-cirque-du-soleil-v-valensii");
  assert.equal(d.source_url, "https://lacotorra.io/events/shou-cirque-du-soleil-v-valensii");
});

test("buildLacotorraEvents: a stale snapshot (no links) does NOT clobber the fresh one's per-event URL", () => {
  const rawText = [
    "Мероприятия",
    "Шоу Cirque du Soleil в Валенсии",
    "Большое цирковое шоу…",
    "9 Jun 2026, 10:00 - 5 Aug 2026, 12:00",
    "Roig Arena",
  ].join("\n");
  const stale = {
    id: 470, // older id, NO event_links
    source_key: LACOTORRA_SOURCE_KEY,
    url: "https://lacotorra.io/events",
    raw_text: rawText,
    raw_json: JSON.stringify({ kind: "page_snapshot", meta: {}, event_links: [] }),
  };
  const fresh = {
    id: 1023, // newer id, has the per-event link
    source_key: LACOTORRA_SOURCE_KEY,
    url: "https://lacotorra.io/events",
    raw_text: rawText,
    raw_json: JSON.stringify({
      kind: "page_snapshot",
      meta: {},
      event_links: [
        { title: "Шоу Cirque du Soleil в Валенсии", url: "https://lacotorra.io/events/shou-cirque-du-soleil-v-valensii" },
      ],
    }),
  };
  // stale listed FIRST (DB id order) — without latestSnapshotRows it would win the dedupe.
  const events = buildLacotorraEvents([stale, fresh], REF);
  assert.equal(events.length, 1);
  assert.equal(events[0].draft.source_url, "https://lacotorra.io/events/shou-cirque-du-soleil-v-valensii");
});

test("buildLacotorraEvents: falls back to the index when no card link matches", () => {
  const snapshot = {
    id: 471,
    source_key: LACOTORRA_SOURCE_KEY,
    url: "https://lacotorra.io/events",
    raw_text: [
      "Мероприятия",
      "Концерт без ссылки в Валенсии",
      "Описание события…",
      "9 Jun 2026, 20:00",
      "Площадка",
    ].join("\n"),
    raw_json: JSON.stringify({ kind: "page_snapshot", meta: {}, event_links: [] }),
  };
  const events = buildLacotorraEvents([snapshot], REF);
  assert.equal(events.length, 1);
  assert.equal(events[0].draft.source_url, "https://lacotorra.io/events");
});

test("buildCacEvents: sets per-event url+source_url from event_links", () => {
  const snapshot = {
    id: 600,
    source_key: "web:cac_exposiciones",
    url: "https://cac.es/exposiciones/",
    raw_text: [
      "Exposiciones",
      "PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA",
      "Temporal",
      ": 02/07/2026",
      "– 30/09/2026",
      "Recinto:",
      "Museu de les Ciències",
      "Una muestra escultórica del artista coreano que explora el genoma.",
      "Ver más",
    ].join("\n"),
    raw_json: JSON.stringify({
      kind: "page_snapshot",
      meta: {},
      event_links: [
        {
          title: "PARK EUN SUN. GENOMA Y ESTRUCTURA ESCULTÓRICA",
          url: "https://cac.es/exposiciones/exposicion-park-eun-sun-valencia/",
        },
      ],
    }),
  };
  const events = buildCacEvents([snapshot], REF);
  assert.equal(events.length, 1);
  const d = events[0].draft;
  assert.equal(d.url, "https://cac.es/exposiciones/exposicion-park-eun-sun-valencia/");
  assert.equal(d.source_url, "https://cac.es/exposiciones/exposicion-park-eun-sun-valencia/");
});

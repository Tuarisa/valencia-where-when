import test from "node:test";
import assert from "node:assert/strict";
import { eventGeoQueries, placeNameFromMapsUrl } from "../lib/pipeline/geo.ts";
import { isCentroid } from "../lib/pipeline/dedup.ts";

// Pure-logic mirror of lib/pipeline/geo.ts `mapsAddressQuery` (T135). The Google-Maps
// `q=` text leads with the VENUE NAME, which fools Nominatim into the València
// city-centre fallback centroid; extracting just the street address resolves to the
// exact venue. This locks the parse that makes that possible.

const STREET_RE = /^(carrer|calle|c\/|avinguda|avenida|av\.?|pla[çc]a|plaza|pl\.?|passeig|paseo|cam[íi]|camino|ronda|gran via|via|partida|pol[íi]gono)(\s|$)/i;

function mapsAddressQuery(qText) {
  if (!qText) return null;
  const segs = qText.split(",").map((s) => s.trim()).filter(Boolean);
  const streetIdx = segs.findIndex((s) => STREET_RE.test(s));
  if (streetIdx === -1) return null;
  let street = segs[streetIdx]
    .replace(/^C\/\s*/i, "Calle ")
    .replace(/^Av\.?\s+/i, "Avenida ")
    .replace(/^Pl\.?\s+/i, "Plaza ")
    .replace(/\s+/g, " ")
    .trim();
  const next = segs[streetIdx + 1];
  const number = next && /^\d+[a-z]?$/i.test(next) ? next : "";
  let locale = segs.find((s) => /\b\d{5}\b/.test(s)) || null;
  if (!locale) {
    const last = segs[segs.length - 1];
    if (last && last !== segs[streetIdx] && last !== number) locale = last;
  }
  const parts = [number ? `${street} ${number}` : street];
  if (locale) parts.push(locale);
  parts.push("Spain");
  return parts.join(", ");
}

test("mapsAddressQuery: drops venue-name prefix, keeps street+number+postcode", () => {
  assert.equal(
    mapsAddressQuery("HANAZONO - Benimaclet, Carrer del Doctor Garcia Brustenga, 3, Benimaclet, 46020 València, Valencia"),
    "Carrer del Doctor Garcia Brustenga 3, 46020 València, Spain",
  );
  assert.equal(
    mapsAddressQuery("Charlie Brownie Restaurante., Carrer de Calixt III, 35, Extramurs, 46008 València, Valencia"),
    "Carrer de Calixt III 35, 46008 València, Spain",
  );
});

test("mapsAddressQuery: normalizes C/ → Calle and tolerates a missing province segment", () => {
  assert.equal(
    mapsAddressQuery("Restaurante Brasayleña Aqua, C/ de Menorca, 19, Camins al Grau, 46023 Valencia"),
    "Calle de Menorca 19, 46023 Valencia, Spain",
  );
});

test("mapsAddressQuery: street with no house number still yields a usable query", () => {
  assert.equal(
    mapsAddressQuery("Parc de Capçalera, Avinguda de Pius XII, Valencia"),
    "Avinguda de Pius XII, Valencia, Spain",
  );
});

test("mapsAddressQuery: returns null when there is no street segment", () => {
  assert.equal(mapsAddressQuery("HANAZONO Benimaclet"), null);
  assert.equal(mapsAddressQuery(""), null);
  assert.equal(mapsAddressQuery(null), null);
});

// T161 — event geocoding venue-name fallback. Many derived events carry a clear
// venue_name (Roig Arena, Plaza de Toros de Valencia, …) but NO address, so the
// address-only path left them at null lat/lng. `eventGeoQueries` now adds a
// `<venue_name>, <city||Valencia>, Spain` query; the caller still gates every hit
// through `isCentroid` so venue names that only resolve to the city centre
// (e.g. Teatro Olympia) stay null rather than getting a fake pin.

test("eventGeoQueries: venue_name with no address yields a venue-name query", () => {
  const qs = eventGeoQueries({ venue_name: "Roig Arena", address: null, city: "Valencia" }, null);
  assert.ok(qs.includes("Roig Arena, Valencia, Spain"), `got ${JSON.stringify(qs)}`);
});

test("eventGeoQueries: defaults missing city to Valencia", () => {
  const qs = eventGeoQueries({ venue_name: "Plaza de Toros de Valencia", address: null, city: null }, null);
  assert.ok(qs.includes("Plaza de Toros de Valencia, Valencia, Spain"), `got ${JSON.stringify(qs)}`);
});

test("eventGeoQueries: honors a non-default city", () => {
  const qs = eventGeoQueries({ venue_name: "Discoteca Eclipse", address: null, city: "Gandia" }, null);
  assert.ok(qs.includes("Discoteca Eclipse, Gandia, Spain"), `got ${JSON.stringify(qs)}`);
});

test("eventGeoQueries: maps `q=` street address ranks first, deduped, no nulls", () => {
  const qs = eventGeoQueries(
    { venue_name: "HANAZONO", address: null, city: "Valencia" },
    "HANAZONO - Benimaclet, Carrer del Doctor Garcia Brustenga, 3, Benimaclet, 46020 València, Valencia",
  );
  assert.equal(qs[0], "Carrer del Doctor Garcia Brustenga 3, 46020 València, Spain");
  assert.ok(qs.every((q) => typeof q === "string" && q.length > 0));
  assert.equal(new Set(qs).size, qs.length); // deduped
});

test("eventGeoQueries: no venue_name and no address → only a bare city query (centroid-guarded)", () => {
  // joinParts always appends city+Spain, so the list is the lone "<city>, Spain"
  // query. That resolves to the València centroid, which the caller's isCentroid
  // guard then rejects — so such an event correctly stays null rather than mispinned.
  assert.deepEqual(eventGeoQueries({ venue_name: null, address: null, city: "Valencia" }, null), ["Valencia, Spain"]);
});

test("fallback decision: a real venue coord is kept, a city centroid is rejected", () => {
  // Roig Arena resolves to a real, distinct pin → kept (not a centroid).
  assert.equal(isCentroid(39.4493, -0.3573), false);
  // València generic-centre fallback (Teatro Olympia's venue-name hit) → rejected.
  assert.equal(isCentroid(39.4697065, -0.3763353), true);
});

// ===================== T193: placeNameFromMapsUrl (resolved Google-Maps URL → venue name) =====================
// Early logunespa places were stored with the raw `maps.app.goo.gl/<short>` URL AS the name.
// Following the redirect yields a real Google-Maps URL; these lock the deterministic parse
// that recovers the venue name from its real-world shapes (no network in the test).

test("placeNameFromMapsUrl: ?q=<Venue>, <address> → the venue (first comma-segment, +→space)", () => {
  // Real resolved target for the Cafe Montoro short-link.
  assert.equal(
    placeNameFromMapsUrl("https://www.google.com/maps?q=Cafe+Montoro,+C/+del+Dr.+%C3%81lvaro+L%C3%B3pez,+81,+46011+Val%C3%A8ncia,+Valencia&ftid=0xabc"),
    "Cafe Montoro",
  );
});

test("placeNameFromMapsUrl: chain-store ?q= keeps the branch in the venue segment", () => {
  assert.equal(
    placeNameFromMapsUrl("https://www.google.com/maps?q=Costco+Wholesale+Zaragoza,+Calle+Isla+de+Pantelaria,+38,+50197+Zaragoza&entry=gps"),
    "Costco Wholesale Zaragoza",
  );
});

test("placeNameFromMapsUrl: /maps/place/<Venue>/@lat,lng path form → decoded venue", () => {
  assert.equal(
    placeNameFromMapsUrl("https://www.google.com/maps/place/Mercado+Central/@39.4738,-0.3795,17z/data=!4m"),
    "Mercado Central",
  );
});

test("placeNameFromMapsUrl: a bare-postcode locality strips the 5-digit postcode", () => {
  // ids 13/14 — the q= is just "<postcode> <Locality>, Valencia" (no venue).
  assert.equal(placeNameFromMapsUrl("https://www.google.com/maps?q=46140+Ademuz,+Valencia&entry=gps"), "Ademuz");
  assert.equal(placeNameFromMapsUrl("https://www.google.com/maps?q=46593+Algar+de+Palancia,+Valencia"), "Algar de Palancia");
});

test("placeNameFromMapsUrl: percent-encoded Cyrillic/accents decode correctly", () => {
  assert.equal(placeNameFromMapsUrl("https://www.google.com/maps?q=La+H%C3%ADpica,+Carrer+del+Pintor"), "La Hípica");
});

test("placeNameFromMapsUrl: no name segment / null / a bare short-link → null (caller falls back)", () => {
  assert.equal(placeNameFromMapsUrl(null), null);
  assert.equal(placeNameFromMapsUrl(""), null);
  // an unfollowed short-link is itself URL-ish → no name
  assert.equal(placeNameFromMapsUrl("https://maps.app.goo.gl/ayWzLFSR1RTmsVyaA"), null);
  // a coords-only q= has no textual name
  assert.equal(placeNameFromMapsUrl("https://www.google.com/maps?q=39.4697,-0.3763"), null);
});

import test from "node:test";
import assert from "node:assert/strict";

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

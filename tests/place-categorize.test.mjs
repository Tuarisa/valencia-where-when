import test from "node:test";
import assert from "node:assert/strict";

// Pure-logic mirror of the places catalog facets + filter (app/places/page.tsx, T063/T065):
// how the catalog derives its category/area/tag facets and which places a given filter
// keeps. Locks the deterministic SSR filtering so a refactor can't silently change it.

const norm = (s) => (s || "").trim();

function facetValues(places, pick) {
  return Array.from(new Set(places.map(pick).map(norm).filter(Boolean))).sort();
}

function topTags(places, n = 16) {
  const count = new Map();
  for (const p of places) for (const t of p.tags || []) count.set(t, (count.get(t) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
}

function placeMatches(p, { category = "", area = "", tag = "", q = "" }) {
  if (category && norm(p.category) !== category) return false;
  if (area && (norm(p.area) || norm(p.district)) !== area) return false;
  if (tag && !(p.tags || []).includes(tag)) return false;
  if (q) {
    const hay = `${p.name} ${p.excerpt || ""} ${p.location_label || ""} ${p.category || ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

const PLACES = [
  { id: 1, name: "Empanada Club", category: "ресторан", area: "Ruzafa", district: null, tags: ["еда", "аргентина"], excerpt: "лучшие эмпанадас", location_label: "Ruzafa" },
  { id: 2, name: "Bluebell Coffee", category: "кафе", area: "", district: "Eixample", tags: ["кофе", "еда"], excerpt: "спешелти кофе", location_label: "Eixample" },
  { id: 3, name: "Bioparc", category: "парк", area: "", district: "", tags: ["природа"], excerpt: "зоопарк", location_label: "Valencia" },
  { id: 4, name: "La Vash", category: "ресторан", area: "Ruzafa", district: null, tags: ["еда", "грузия"], excerpt: "хинкали", location_label: "Ruzafa" },
];

test("facetValues: unique + sorted; area falls back to district", () => {
  assert.deepEqual(facetValues(PLACES, (p) => p.category), ["кафе", "парк", "ресторан"]);
  // area || district, blank dropped (Bioparc has neither)
  assert.deepEqual(
    facetValues(PLACES, (p) => norm(p.area) || norm(p.district)),
    ["Eixample", "Ruzafa"],
  );
});

test("topTags: ranked by frequency", () => {
  const tags = topTags(PLACES, 3);
  assert.equal(tags[0], "еда"); // appears 3×, most frequent
  assert.ok(tags.includes("кофе") || tags.includes("аргентина"));
});

test("placeMatches: category filter", () => {
  const kept = PLACES.filter((p) => placeMatches(p, { category: "ресторан" }));
  assert.deepEqual(kept.map((p) => p.id), [1, 4]);
});

test("placeMatches: area filter uses district fallback", () => {
  const kept = PLACES.filter((p) => placeMatches(p, { area: "Eixample" }));
  assert.deepEqual(kept.map((p) => p.id), [2]);
});

test("placeMatches: tag filter", () => {
  const kept = PLACES.filter((p) => placeMatches(p, { tag: "грузия" }));
  assert.deepEqual(kept.map((p) => p.id), [4]);
});

test("placeMatches: free-text q across name/excerpt/category", () => {
  assert.deepEqual(PLACES.filter((p) => placeMatches(p, { q: "кофе" })).map((p) => p.id), [2]);
  assert.deepEqual(PLACES.filter((p) => placeMatches(p, { q: "хинкали" })).map((p) => p.id), [4]);
});

test("placeMatches: combined facets AND together", () => {
  const kept = PLACES.filter((p) => placeMatches(p, { category: "ресторан", tag: "грузия" }));
  assert.deepEqual(kept.map((p) => p.id), [4]);
  assert.deepEqual(PLACES.filter((p) => placeMatches(p, {})).map((p) => p.id), [1, 2, 3, 4]);
});

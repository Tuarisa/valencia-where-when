import test from "node:test";
import assert from "node:assert/strict";

// Pure-logic mirror of lib/queries.ts buildTagCloud / buildCategories (T163, design
// pass). The real functions take SiteEvent/SitePlace shapes; here we feed minimal
// {tags} / {category} stubs and lock the deterministic frequency aggregation + ordering
// + cap that the tag-cloud and category-filter UI rely on.

// Mirror of buildTagCloud (events+places, weighted by total occurrence count).
function buildTagCloud(events, places, limit = 36) {
  const counts = new Map();
  for (const e of events) for (const t of e.tags) counts.set(t, (counts.get(t) || 0) + 1);
  for (const p of places) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

// Mirror of buildCategories (events only, case-normalized, blank skipped).
function buildCategories(events, limit = 14) {
  const counts = new Map();
  for (const e of events) {
    const c = (e.category || "").trim().toLowerCase();
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([category, count]) => ({ category, count }));
}

test("buildTagCloud: weights by frequency across events AND places", () => {
  const events = [{ tags: ["music", "free"] }, { tags: ["music"] }];
  const places = [{ tags: ["music", "park"] }];
  const cloud = buildTagCloud(events, places);
  const byTag = Object.fromEntries(cloud.map((c) => [c.tag, c.count]));
  assert.equal(byTag.music, 3); // 2 events + 1 place
  assert.equal(byTag.free, 1);
  assert.equal(byTag.park, 1);
});

test("buildTagCloud: most-frequent first, ties alphabetical (deterministic)", () => {
  const events = [{ tags: ["b"] }, { tags: ["a"] }, { tags: ["c", "c"] }];
  const cloud = buildTagCloud(events, []);
  assert.deepEqual(cloud.map((c) => c.tag), ["c", "a", "b"]); // c(2) then a,b tie → a,b
});

test("buildTagCloud: honours the limit cap", () => {
  const events = Array.from({ length: 50 }, (_, i) => ({ tags: [`t${i}`] }));
  assert.equal(buildTagCloud(events, [], 36).length, 36);
});

test("buildCategories: counts events, skips blank, case-normalizes", () => {
  const events = [
    { category: "Concert" },
    { category: "concert" },
    { category: "Exhibition" },
    { category: "" },
    { category: null },
  ];
  const cats = buildCategories(events);
  const byCat = Object.fromEntries(cats.map((c) => [c.category, c.count]));
  assert.equal(byCat.concert, 2); // Concert + concert collapse
  assert.equal(byCat.exhibition, 1);
  assert.equal(cats.length, 2); // blank + null skipped
});

test("buildCategories: ordered by count desc then name", () => {
  const events = [
    { category: "music" },
    { category: "art" },
    { category: "music" },
    { category: "zoo" },
  ];
  assert.deepEqual(
    buildCategories(events).map((c) => c.category),
    ["music", "art", "zoo"],
  );
});

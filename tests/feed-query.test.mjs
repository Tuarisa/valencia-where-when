import test from "node:test";
import assert from "node:assert/strict";

// Pure-logic mirror of lib/queries.ts feed rules (T060/T061/T065): which rows the feed
// shows, how an event's special "feature" is classified, and which month the calendar
// opens on (SC-005). The real getEvents() runs the status filter in SQL; this locks the
// equivalent predicate + the pure featureKind / default-month logic.

function loadTags(json) {
  try {
    const a = JSON.parse(json || "[]");
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

// Mirror of queries.ts featureKind.
function featureKind(row) {
  const src = row.source || "";
  if (src === "api:hemisferic") return "hemisferic";
  if (src === "web:feriadejuliovlc") return "feria";
  const tags = loadTags(row.tags_json);
  if (tags.includes("feria-de-julio")) return "feria";
  const cat = (row.category || "").toLowerCase();
  if (cat === "festival" || cat === "fireworks") return "festival";
  if (tags.includes("festival") || tags.includes("featured")) return "festival";
  return null;
}

// Mirror of getEvents() WHERE status = 'upcoming' OR status IS NULL — duplicates
// (dedup losers → status='duplicate'), ignored and raw rows are excluded.
const feedVisible = (status) => status == null || status === "upcoming";

// Mirror of buildPayload default-month: first month with events on/after the current
// month, else the last available month, else null (SC-005).
function pickDefaultMonth(startDates, todayMonth) {
  const months = Array.from(
    new Set(startDates.filter(Boolean).map((d) => d.slice(0, 7))),
  ).sort();
  const future = months.filter((m) => m >= todayMonth);
  return future[0] || months[months.length - 1] || null;
}

test("featureKind: source-based feria/hemisferic win first", () => {
  assert.equal(featureKind({ source: "api:hemisferic" }), "hemisferic");
  assert.equal(featureKind({ source: "web:feriadejuliovlc" }), "feria");
});

test("featureKind: tag + category fallbacks", () => {
  assert.equal(featureKind({ tags_json: '["feria-de-julio"]' }), "feria");
  assert.equal(featureKind({ category: "fireworks" }), "festival");
  assert.equal(featureKind({ category: "Festival" }), "festival");
  assert.equal(featureKind({ tags_json: '["featured"]' }), "festival");
  assert.equal(featureKind({ source: "tg:logunespa", category: "concert" }), null);
  assert.equal(featureKind({}), null);
});

test("feedVisible: upcoming/null shown, duplicate/ignored/raw hidden", () => {
  assert.equal(feedVisible("upcoming"), true);
  assert.equal(feedVisible(null), true);
  assert.equal(feedVisible(undefined), true);
  assert.equal(feedVisible("duplicate"), false);
  assert.equal(feedVisible("ignored"), false);
  assert.equal(feedVisible("raw"), false);
});

test("pickDefaultMonth: current month when it has events", () => {
  assert.equal(
    pickDefaultMonth(["2026-06-21", "2026-07-02", "2026-08-01"], "2026-06"),
    "2026-06",
  );
});

test("pickDefaultMonth: nearest FUTURE month when current is empty", () => {
  assert.equal(pickDefaultMonth(["2026-08-01", "2026-09-10"], "2026-06"), "2026-08");
});

test("pickDefaultMonth: falls back to last month when all are past, null when no dates", () => {
  assert.equal(pickDefaultMonth(["2025-01-01", "2025-02-01"], "2026-06"), "2025-02");
  assert.equal(pickDefaultMonth([], "2026-06"), null);
});

import test from "node:test";
import assert from "node:assert/strict";

// T175 — standing-exhibition ("экспозиция") detection + calendar spanning-bar layout.
// isExposition / featureKind are imported from the REAL module so this locks the shipping
// rule. The badge + week-segment helpers live in app/Home.tsx (a client component) and are
// mirrored here 1:1 — keep them lock-step with Home.tsx.
import { isExposition, featureKind } from "../lib/queries.ts";

// ---- isExposition (the detection rule) -------------------------------------------------

test("isExposition: exhibition text + multi-day span → true", () => {
  // The 6 live ground-truth expositions.
  assert.equal(isExposition({ title: "Выставка про мир «Алисы в Стране чудес»", category: "culture", start_date: "2026-04-16", end_date: "2026-10-12" }), true);
  assert.equal(isExposition({ title: "Выставка Ансельма Кифера", category: "culture", start_date: "2026-04-29", end_date: "2026-10-25" }), true);
  assert.equal(isExposition({ title: "Новая большая экспозиция IVAM", category: "culture", start_date: "2026-06-17", end_date: "2028-04-23" }), true);
  // ES + EN text signals also qualify.
  assert.equal(isExposition({ title: "Exposición de Frida Kahlo", category: "art", start_date: "2026-06-09", end_date: "2026-08-05" }), true);
  assert.equal(isExposition({ title: "Picasso exhibition", category: "art", start_date: "2026-03-01", end_date: "2026-09-01" }), true);
});

test("isExposition: multi-day 'culture' with no other kind → true (fallback)", () => {
  assert.equal(isExposition({ title: "Muestra en el museo", category: "culture", start_date: "2026-05-15", end_date: "2026-07-01" }), true);
});

test("isExposition: a single-day or short-span event is NOT an exposition", () => {
  // No end_date → a normal one-off.
  assert.equal(isExposition({ title: "Выставка одного дня", category: "culture", start_date: "2026-06-10", end_date: null }), false);
  // end_date == start_date → not multi-day.
  assert.equal(isExposition({ title: "Выставка", category: "culture", start_date: "2026-06-10", end_date: "2026-06-10" }), false);
  // span shorter than the minimum (4 days).
  assert.equal(isExposition({ title: "Выставка", category: "culture", start_date: "2026-06-10", end_date: "2026-06-12" }), false);
});

test("isExposition: a long span that is NOT an exhibition stays false", () => {
  // A concert run with no exhibition signal and a non-culture category.
  assert.equal(isExposition({ title: "Концертный сезон оркестра", category: "concert", start_date: "2026-04-01", end_date: "2026-10-01" }), false);
  assert.equal(isExposition({ title: "Летний фестиваль", category: "festival", start_date: "2026-07-01", end_date: "2026-08-01" }), false);
});

test("featureKind: exposition kind exposed; festival span NOT reclassified", () => {
  assert.equal(featureKind({ title: "Выставка Кифера", category: "culture", start_date: "2026-04-29", end_date: "2026-10-25" }), "exposition");
  // An explicit festival category still wins (exposition check runs after it).
  assert.equal(featureKind({ title: "Festival run", category: "festival", start_date: "2026-07-01", end_date: "2026-08-01" }), "festival");
  // Hemisfèric source still wins first.
  assert.equal(featureKind({ source: "api:hemisferic", category: "culture", start_date: "2026-04-01", end_date: "2026-10-01" }), "hemisferic");
});

// ---- expositionBadge (feed badge text), mirror of app/Home.tsx ------------------------

const MONTH_ABBR_RU = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
function expositionBadge(item, today) {
  if (!item.end_date) return "постоянная экспозиция";
  const end = item.end_date.slice(0, 10);
  const todayDate = today.slice(0, 10);
  const yearsOut = (Date.parse(end) - Date.parse(todayDate)) / (365 * 86_400_000);
  if (yearsOut > 1) return "постоянная экспозиция";
  const [, m, d] = end.split("-");
  return `идёт до ${Number(d)} ${MONTH_ABBR_RU[Number(m) - 1]}`;
}

test("expositionBadge: near-term end → 'идёт до DD месяца'", () => {
  assert.equal(expositionBadge({ end_date: "2026-10-12" }, "2026-06-21"), "идёт до 12 окт");
  assert.equal(expositionBadge({ end_date: "2026-08-05" }, "2026-06-21"), "идёт до 5 авг");
});

test("expositionBadge: far-future / open-ended → 'постоянная экспозиция'", () => {
  // IVAM →2028 is >1 year out.
  assert.equal(expositionBadge({ end_date: "2028-04-23" }, "2026-06-21"), "постоянная экспозиция");
  assert.equal(expositionBadge({ end_date: null }, "2026-06-21"), "постоянная экспозиция");
});

// ---- week-segment clamping (calendar spanning bar), mirror of app/Home.tsx ------------
// For a given visible month, an exposition clamped to that month is split into per-week
// grid segments. This mirrors the core of the expoLanes useMemo.
function expoSegments(monthKey, e) {
  const [year, month] = monthKey.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDay = new Date(year, month - 1, 1);
  const offset = (firstDay.getDay() + 6) % 7;
  const monthStartMs = Date.UTC(year, month - 1, 1);
  const monthEndMs = Date.UTC(year, month - 1, daysInMonth);
  const realStart = Date.parse(e.start_date.slice(0, 10));
  const realEnd = Date.parse(e.end_date.slice(0, 10));
  if (realStart > monthEndMs || realEnd < monthStartMs) return []; // no overlap
  const clampStartDay = realStart < monthStartMs ? 1 : new Date(realStart).getUTCDate();
  const clampEndDay = realEnd > monthEndMs ? daysInMonth : new Date(realEnd).getUTCDate();
  const startIdx = offset + clampStartDay - 1;
  const endIdx = offset + clampEndDay - 1;
  const segs = [];
  let idx = startIdx;
  while (idx <= endIdx) {
    const week = Math.floor(idx / 7);
    const weekEndIdx = Math.min(endIdx, week * 7 + 6);
    segs.push({ week, colStart: (idx % 7) + 1, span: weekEndIdx - idx + 1 });
    idx = weekEndIdx + 1;
  }
  return segs;
}

test("expoSegments: a mid-month exposition spans only its own days, split per week", () => {
  // PUPAE 2026-05-29 .. 2026-06-26 viewed in June: covers June 1..26.
  const segs = expoSegments("2026-06", { start_date: "2026-05-29", end_date: "2026-06-26" });
  // Total covered columns across all segments = 26 days (June 1..26).
  const total = segs.reduce((n, s) => n + s.span, 0);
  assert.equal(total, 26);
  // Multiple week rows (June 1..26 spans >1 week).
  assert.ok(segs.length >= 4, `expected multiple week segments, got ${segs.length}`);
});

test("expoSegments: an Apr→Oct exposition fills the whole of June (full-width bar)", () => {
  // Алиса 2026-04-16 .. 2026-10-12 viewed in June → clamped to June 1..30.
  const segs = expoSegments("2026-06", { start_date: "2026-04-16", end_date: "2026-10-12" });
  const total = segs.reduce((n, s) => n + s.span, 0);
  assert.equal(total, 30); // every day of June
});

test("expoSegments: a non-overlapping month yields no segments", () => {
  // Алиса does NOT touch January 2026.
  assert.deepEqual(expoSegments("2026-01", { start_date: "2026-04-16", end_date: "2026-10-12" }), []);
});

test("expoSegments: span never exceeds 7 columns per week-row", () => {
  const segs = expoSegments("2026-06", { start_date: "2026-04-16", end_date: "2026-10-12" });
  for (const s of segs) assert.ok(s.span >= 1 && s.span <= 7, `bad span ${s.span}`);
});

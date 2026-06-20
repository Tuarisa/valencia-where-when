// Promptfoo test-case generator (sub-area I, T090). Loads every golden fixture in this
// directory and emits one promptfoo test case per fixture, threading the fixture's
// `expected` fields into per-case assertions. Degrades GRACEFULLY when the directory is
// empty (returns []) so the harness never errors before fixtures exist (bundle C is
// creating them concurrently).
//
// Agreed fixture shape (one *.json per file OR an array of them):
//   {
//     "id": str,
//     "path": "A" | "B" | "series",
//     "input":    { title, description, source, category, links? , ... },   // the card
//     "expected": { description_ru?, tags?, confidence?, links_json?, ... }  // EnrichmentResult-shaped
//   }
//
// Promptfoo loads this via `tests: file://…/generate.mjs` and calls the default export.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// PURE: build the per-case assertions from a fixture's `expected`. Keeps the eval
// honest about the two paths (T139) without inventing facts the fixture doesn't pin.
function assertsFor(fx) {
  const exp = fx.expected || {};
  const asserts = [];

  // Output must always be a JSON object (defaultTest also asserts is-json; harmless dup
  // removed by keeping only the targeted asserts here).

  // Expected venue name → fuzzy (Levenshtein ≥0.85) match somewhere in the output JSON
  // (T090). Grounding (PATH B) should recover the venue from the source link.
  if (exp.venue_name) {
    asserts.push({
      type: "levenshtein",
      value: String(exp.venue_name),
      threshold: 0.85,
      // Compare against the whole JSON output; the venue string should appear verbatim.
      transform: "JSON.stringify(JSON.parse(output))",
    });
  }

  // Expected date → exact (±0) substring presence in the output (T090 "fuzzy date ±0").
  for (const f of ["start_date", "end_date"]) {
    if (exp[f]) {
      asserts.push({
        type: "contains",
        value: String(exp[f]),
      });
    }
  }

  // Expected address (PATH B grounding) → present in the output.
  if (exp.address) {
    asserts.push({ type: "contains", value: String(exp.address) });
  }

  // Confidence floor, when the fixture pins a minimum expectation.
  if (typeof exp.confidence === "number") {
    asserts.push({
      type: "javascript",
      value: `JSON.parse(output).confidence >= ${exp.confidence} - 0.0001`,
    });
  }

  // Expected source links must all survive into links/links_json (dedup keeps a link to
  // every source — constitution). Gather the wanted URLs from whichever form the fixture
  // pins: `expected.links` (array of {url}) and/or `expected.links_json` (array OR a
  // JSON-encoded string). One javascript assert checks containment in the output.
  const wanted = new Set();
  if (Array.isArray(exp.links)) {
    for (const l of exp.links) if (l && l.url) wanted.add(String(l.url));
  }
  if (Array.isArray(exp.links_json)) {
    for (const l of exp.links_json) {
      if (typeof l === "string") wanted.add(l);
      else if (l && l.url) wanted.add(String(l.url));
    }
  } else if (typeof exp.links_json === "string") {
    try {
      const arr = JSON.parse(exp.links_json);
      if (Array.isArray(arr)) for (const l of arr) if (l && l.url) wanted.add(String(l.url));
    } catch {
      /* not JSON → ignore */
    }
  }
  if (wanted.size) {
    asserts.push({
      type: "javascript",
      value:
        "const o = JSON.parse(output); const blob = JSON.stringify(o.links || o.links_json || []); " +
        `return ${JSON.stringify([...wanted])}.every((u) => blob.includes(u));`,
    });
  }

  return asserts;
}

function loadFixtures() {
  let entries;
  try {
    entries = readdirSync(HERE);
  } catch {
    return []; // dir absent → no cases
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const full = join(HERE, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      // A malformed fixture should not crash the whole eval — skip with a warning.
      process.stderr.write(`[enrich-eval] skipping malformed fixture ${name}: ${err.message}\n`);
      continue;
    }
    // A file may hold a single fixture object or an array of them.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const fx of items) {
      if (fx && typeof fx === "object" && fx.input) out.push({ ...fx, __file: name });
    }
  }
  return out;
}

// Promptfoo's default export for a test generator: returns an array of test cases.
export default function generateTests() {
  const fixtures = loadFixtures();
  if (!fixtures.length) {
    process.stderr.write(
      "[enrich-eval] no fixtures found in tests/fixtures/enrich/ — eval will report 0 cases\n"
    );
    return [];
  }
  return fixtures.map((fx) => ({
    description: `${fx.id || fx.__file} [path ${fx.path || "A"}]`,
    vars: {
      // The provider parses `card` back into the EnrichInput; `path` drives web grounding.
      card: JSON.stringify(fx.input),
      path: fx.path || "A",
    },
    assert: assertsFor(fx),
  }));
}

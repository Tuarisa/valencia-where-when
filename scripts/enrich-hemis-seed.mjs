// One-off: enrich the 104 api:hemisferic events in data/seed/events.json.
// They are 11 DISTINCT shows -> enrich each show ONCE (haiku, no web), then APPLY
// title_ru/description_ru (+tags if produced) to ALL occurrences of that title.
// Writes events.json back with the canonical column ORDER for the hemis rows so the
// whole file is column-set + column-order consistent. Does NOT touch the 239 derived.
import { readFileSync, writeFileSync } from "node:fs";
import { createClaudeEnrichClient } from "../lib/pipeline/enrich-client.ts";
import { normalizeEnrichment } from "../lib/pipeline/enrich.ts";

const COLS = ["id","dedup_hash","title","description","category","language","audience","start_date","end_date","start_time","end_time","timezone","venue_name","district","address","city","country","lat","lng","geo_source","location_notes","price","is_free","url","venue_url","image_url","external_ref","source","source_url","raw_excerpt","source_item_id","tags_json","metadata_json","title_ru","description_ru","links_json","enrichment_json","enriched_at","status","score","first_seen","last_seen","notified","notified_at"];

const path = "data/seed/events.json";
const ev = JSON.parse(readFileSync(path, "utf8"));
const hemis = ev.filter((e) => e.source === "api:hemisferic");
const byTitle = new Map();
for (const e of hemis) {
  if (!byTitle.has(e.title)) byTitle.set(e.title, []);
  byTitle.get(e.title).push(e);
}

const client = createClaudeEnrichClient();
const ruByTitle = new Map();
let i = 0;
for (const [title, arr] of byTitle) {
  const rep = arr[0];
  const t0 = Date.now();
  const raw = await client.enrich(
    { id: rep.id, title: rep.title, description: rep.description, source: rep.source, category: rep.category, source_url: null },
    { web: false },
  );
  const r = normalizeEnrichment(raw); // clamp/coerce; we only promote title_ru/description_ru
  ruByTitle.set(title, { title_ru: r.title_ru || null, description_ru: r.description_ru || null });
  i++;
  console.error(`[${i}/${byTitle.size}] ${(Date.now() - t0)}ms | ${title} -> ${r.title_ru}`);
}

// apply to every occurrence, by title
for (const e of ev) {
  if (e.source !== "api:hemisferic") continue;
  const ru = ruByTitle.get(e.title);
  if (!ru) continue;
  if (ru.title_ru) e.title_ru = ru.title_ru;
  if (ru.description_ru) e.description_ru = ru.description_ru;
}

// rewrite hemis rows in canonical column ORDER (the 239 derived already are);
// non-hemis rows pass through unchanged.
const out = ev.map((e) => {
  if (e.source !== "api:hemisferic") return e;
  const o = {};
  for (const c of COLS) o[c] = e[c] === undefined ? null : e[c];
  return o;
});

writeFileSync(path, JSON.stringify(out, null, 2) + "\n", "utf-8");
const after = out.filter((e) => e.source === "api:hemisferic");
console.error("hemis rows:", after.length, "| with title_ru:", after.filter((e) => e.title_ru).length, "| distinct titles:", new Set(after.map((e) => e.title)).size);
process.exit(0);

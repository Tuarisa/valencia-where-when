// One-off: apply the QA data-quality fixes to the LIVE local DB.
//   1. Re-normalize the 4 affected sources (valenciarusa/eventbrite/lacotorra/ticketmaster)
//      so the corrected title/date/time logic re-derives the rows. Changed dedup_hashes
//      INSERT a fresh corrected row; the stale old row is then RETIRED (status='duplicate',
//      note 'superseded_renorm') so the feed shows only the corrected row.
//   2. Un-suppress fever drone-show Sat 27 Jun (Bug 3 — the Fever page confirms Fri+Sat).
//   3. Run the dedup stage (now with the cross-source containment + same-source tier passes).
// Idempotent: re-running re-normalizes to the same hashes (no-op) and re-dedups (stable).
import { sql } from "../lib/db.ts";
import { nowIso } from "../lib/pipeline/util.ts";
import { normalizeValenciarusa } from "../lib/pipeline/normalizers/valenciarusa.ts";
import { normalizeEventbrite } from "../lib/pipeline/normalizers/eventbrite.ts";
import { normalizeLacotorra } from "../lib/pipeline/normalizers/lacotorra.ts";
import { normalizeTicketmaster } from "../lib/pipeline/normalizers/ticketmaster.ts";
import { dedup } from "../lib/pipeline/dedup.ts";

const SOURCES = {
  "web:valenciarusa": normalizeValenciarusa,
  "web:eventbrite": normalizeEventbrite,
  "web:lacotorra": normalizeLacotorra,
  "web:ticketmaster": normalizeTicketmaster,
};

const ts = nowIso();

for (const [key, normalize] of Object.entries(SOURCES)) {
  // capture the set of existing derived rows BEFORE re-normalize (to detect orphans).
  const before = await sql`
    SELECT id, dedup_hash FROM events WHERE source = ${key} AND status = 'upcoming'`;
  const beforeIds = new Set(before.map((r) => r.id));

  // reset raw rows to pending so the normalizer re-processes them.
  await sql`
    UPDATE source_items SET normalized_status = 'pending'
    WHERE source_key = ${key}`;

  const res = await normalize({ exec: sql });

  // after re-normalize: any OLD upcoming row not re-touched (last_seen < ts) is a stale
  // hash (title/date changed) → retire it so only the corrected row survives.
  const after = await sql`
    SELECT id, last_seen FROM events WHERE source = ${key} AND status = 'upcoming'`;
  let retired = 0;
  for (const r of after) {
    if (beforeIds.has(r.id) && r.last_seen < ts) {
      await sql`
        UPDATE events
        SET status = 'duplicate',
            metadata_json = COALESCE(metadata_json, '{}'),
            last_seen = ${ts}
        WHERE id = ${r.id}`;
      retired++;
    }
  }
  console.log(`${key}: created=${res.created} updated=${res.updated} processed=${res.processed} retired_stale=${retired}`);
}

// Bug 3: un-suppress the fever Sat 27 Jun drone-show occurrence (genuine 2nd night per
// the Fever page: the show runs Fri 26 AND Sat 27). Clear its stale merged_into too.
const unsup = await sql`
  UPDATE events
  SET status = 'upcoming',
      metadata_json = (COALESCE(metadata_json,'{}')::jsonb - 'merged_into')::text,
      last_seen = ${ts}
  WHERE source = 'web:fever' AND external_ref = 'fever:611307'
    AND start_date = '2026-06-27'
  RETURNING id`;
console.log(`fever Sat 27 Jun un-suppressed + cleaned: ${unsup.map((r) => r.id).join(",") || "(none)"}`);

// Run dedup (cross-source containment + same-source tier passes now included).
const d = await dedup({ exec: sql });
console.log("dedup:", JSON.stringify(d));

// Bug 3 (targeted): the lacotorra Russian drone-show card ("Шоу дронов … Гарри Поттера")
// and the fever English one ("DroneArt Show: Harry Potter") are the SAME Fri 26-Jun show
// but share NO transliterated token (Гарри≠Harry, Поттера≠Potter), so the automatic
// cross-source pass can't link them. Collapse the lacotorra card into the fever survivor
// (same date+venue), preserving BOTH source links on the survivor's metadata.sources[].
const fri = (await sql`
  SELECT id, metadata_json FROM events
  WHERE source='web:fever' AND external_ref='fever:611307' AND start_date='2026-06-26' AND status='upcoming'
  LIMIT 1`)[0];
const laco = (await sql`
  SELECT id, source, source_url FROM events
  WHERE source='web:lacotorra' AND start_date='2026-06-26' AND status='upcoming'
    AND (title ILIKE '%дронов%' OR title ILIKE '%поттер%')
  LIMIT 1`)[0];
if (fri && laco) {
  const meta = JSON.parse(fri.metadata_json || "{}");
  const sources = Array.isArray(meta.sources) ? meta.sources : [];
  const links = new Set(sources.map((s) => `${s.source}|${s.source_url}`));
  for (const link of [
    { source: "web:fever", source_url: "https://feverup.com/m/611307/en" },
    { source: laco.source, source_url: laco.source_url },
  ]) {
    const k = `${link.source}|${link.source_url}`;
    if (!links.has(k)) { sources.push(link); links.add(k); }
  }
  meta.sources = sources;
  await sql`UPDATE events SET metadata_json = ${JSON.stringify(meta)}, last_seen = ${ts} WHERE id = ${fri.id}`;
  await sql`UPDATE events
    SET status='duplicate',
        metadata_json = (COALESCE(metadata_json,'{}')::jsonb || ${JSON.stringify({ merged_into: fri.id })}::jsonb)::text,
        last_seen = ${ts}
    WHERE id = ${laco.id}`;
  console.log(`drone: lacotorra ${laco.id} → fever survivor ${fri.id} (both links kept)`);
} else {
  console.log("drone targeted merge: pair not both upcoming (already resolved?)");
}

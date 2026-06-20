import { sql } from "../db";
import { nowIso, eventHash } from "./util";

// Deterministic normalizer for the Hemisfèric schedule API (one event per
// show/day, sessions kept in metadata). Other sources are normalized by the
// richer multi-source normalizer (see WORKBOARD.md "normalizer port").
export async function normalizeHemisferic(): Promise<{ created: number; updated: number; processed: number }> {
  const rows = (await sql`
    SELECT * FROM source_items
    WHERE source_key = 'api:hemisferic'
      AND (normalized_status IS NULL OR normalized_status = 'pending'
           OR normalized_at IS NULL OR normalized_at < last_seen)
  `) as any[];

  let created = 0;
  let updated = 0;
  const ts = nowIso();

  for (const item of rows) {
    let raw: any = {};
    try {
      raw = JSON.parse(item.raw_json || "{}");
    } catch {
      raw = {};
    }
    const showName: string = raw.show_name || item.title || "Hemisfèric";
    const day: string | null = raw.schedule_date || (item.published_at || "").slice(0, 10) || null;
    const sessions: string[] = Array.isArray(raw.session_times) ? raw.session_times : [];
    const startTime = sessions[0] || null;
    const poster: string | null = raw.poster_url || null;
    const description = `${raw.description || showName}${sessions.length ? `\n\nСеансы: ${sessions.join(", ")}` : ""}`;

    const evt = {
      title: showName,
      start_date: day,
      end_date: null as string | null,
      venue_name: "L'Hemisfèric",
      address: "Av. del Professor López Piñero, 7, Valencia",
    };
    const dedup = eventHash(evt);

    const existing = (await sql`SELECT id FROM events WHERE dedup_hash = ${dedup}`) as any[];
    if (existing.length) {
      await sql`UPDATE events SET last_seen = ${ts}, start_time = ${startTime},
        image_url = COALESCE(image_url, ${poster}), description = ${description},
        url = COALESCE(${item.url ?? null}, url), source_url = COALESCE(${item.url ?? null}, source_url),
        metadata_json = ${JSON.stringify({ sessions })} WHERE dedup_hash = ${dedup}`;
      updated++;
    } else {
      await sql`INSERT INTO events
        (dedup_hash, title, description, category, language, audience, start_date, start_time,
         venue_name, district, address, city, country, image_url, source, source_url, url,
         raw_excerpt, source_item_id, metadata_json, status, first_seen, last_seen)
        VALUES (${dedup}, ${showName}, ${description}, 'show', 'es', 'family', ${day}, ${startTime},
         ${evt.venue_name}, 'Quatre Carreres', ${evt.address}, 'Valencia', 'Spain', ${poster},
         'api:hemisferic', ${item.url ?? null}, ${item.url ?? null}, ${item.raw_text ?? null},
         ${item.id}, ${JSON.stringify({ sessions })}, 'upcoming', ${ts}, ${ts})`;
      created++;
    }
    await sql`UPDATE source_items SET normalized_at = ${ts}, normalized_status = 'normalized' WHERE id = ${item.id}`;
  }

  return { created, updated, processed: rows.length };
}

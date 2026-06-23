import { sql } from "../db";

const SOURCE_WEIGHT_SCORE: Record<string, number> = { gold: 18, good: 10, mine: 3, off: -20 };
const LANG_SCORE: Record<string, number> = { ru: 26, ua: 16, es: 6, en: 5, mixed: 8 };
const CATEGORY_SCORE: Record<string, number> = {
  standup: 24, concert: 21, theatre: 18, festival: 18, gastro: 14,
  show: 14, exhibition: 8, tour_experience: 5, other: 2,
};
const CITY_SCORE: Record<string, number> = {
  Valencia: 18, Alicante: 9, Castellon: 7, Benidorm: 7, Torrent: 6, Sagunto: 6,
};
const GOOD_KEYWORDS = [
  "семейн", "family", "kids", "дет", "free", "бесплат", "festival", "stand up",
  "стендап", "concert", "концерт", "театр", "teatro", "roig arena", "mestalla",
  "rambleta", "flumen", "marina norte",
];
const BORING_KEYWORDS = [
  "guided tour", "tourist bus", "valencia tourist card", "church", "cathedral",
  "jazz wednesdays", "dinner and a flamenco show", "permanent exhibition",
  "museum of illusions", "best spas", "three ways to enjoy", "come to the church",
  "jubilee masses", "guided motorcycle tours", "guided tours of", "tour at",
];

function parseIso(value?: string | null): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function daysUntil(value?: string | null): number | null {
  const d = parseIso(value);
  if (!d) return null;
  const today = new Date();
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((d.getTime() - t0) / 86400_000);
}
function durationDays(start?: string | null, end?: string | null): number {
  const s = parseIso(start), e = parseIso(end);
  if (!s || !e) return 0;
  return Math.max(0, Math.round((e.getTime() - s.getTime()) / 86400_000));
}

export function scoreEvent(event: any, sourceWeight?: string | null): number {
  let score = 0;
  score += SOURCE_WEIGHT_SCORE[sourceWeight || ""] || 0;
  score += LANG_SCORE[event.language || ""] || 0;
  score += CATEGORY_SCORE[event.category || ""] || 0;
  const city = event.city || "";
  score += CITY_SCORE[city] ?? (city ? 1 : 0);

  const audience = event.audience || "";
  if (audience === "family") score += 10;
  else if (audience === "adult") score += 4;

  const days = daysUntil(event.start_date);
  if (days !== null) {
    if (days < 0) score -= 40;
    else if (days <= 7) score += 20;
    else if (days <= 21) score += 16;
    else if (days <= 45) score += 10;
    else if (days <= 90) score += 4;
    else score -= 6;
  } else score -= 24;

  const duration = durationDays(event.start_date, event.end_date);
  if (duration >= 120) score -= 26;
  else if (duration >= 45) score -= 12;

  const text = `${(event.title || "").toLowerCase()} ${(event.description || "").toLowerCase()}`;
  for (const kw of GOOD_KEYWORDS) if (text.includes(kw)) { score += 4; break; }
  for (const kw of BORING_KEYWORDS) if (text.includes(kw)) { score -= 22; break; }

  if (event.is_free === 1) score += 4;
  if (event.source === "web:visitvalencia" && duration >= 90) score -= 12;
  if (["web:worldafisha", "web:valenciarusa", "tg:concerten"].includes(event.source) &&
      ["Valencia", "Alicante"].includes(event.city)) score += 8;

  return Math.max(0, Math.min(100, score));
}

export async function scoreAll(): Promise<{ scored: number }> {
  const sources = (await sql`SELECT key, weight FROM sources`) as any[];
  const weightByKey = new Map(sources.map((s) => [s.key, s.weight]));
  const events = (await sql`SELECT * FROM events WHERE status = 'upcoming' OR status IS NULL`) as any[];
  if (events.length === 0) return { scored: 0 };
  // Batch the writes: one UPDATE joins against a parallel-array unnest instead of
  // N per-row UPDATEs (Neon does one HTTP round-trip per statement — F4/T184). The
  // per-row score is still computed in JS; only the WRITE collapses to O(1).
  const ids: number[] = [];
  const scores: number[] = [];
  for (const e of events) {
    ids.push(e.id);
    scores.push(scoreEvent(e, weightByKey.get(e.source)));
  }
  await sql`
    UPDATE events AS e SET score = v.score
    FROM unnest(${ids}::int[], ${scores}::int[]) AS v(id, score)
    WHERE e.id = v.id
  `;
  return { scored: events.length };
}

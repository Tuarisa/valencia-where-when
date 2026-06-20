import { sql } from "../../db";
import { nowIso } from "../util";

// Shared types/helpers for the normalizer registry. A normalizer reads a pending
// `source_items` row and produces event/place drafts plus a status; the dispatch
// layer (see normalize.ts) records the status back onto the raw row via
// `markRawItem` — which only ever UPDATEs bookkeeping columns, never deletes the
// raw row (constitution I: raw layer is append-only).

// A pending raw row as read from `source_items`. Loose by design — different
// sources carry different shapes in `raw_json`/`raw_text`.
export interface RawItem {
  id: number;
  source_key: string;
  item_type?: string | null;
  external_id?: string | null;
  title?: string | null;
  url?: string | null;
  published_at?: string | null;
  raw_text?: string | null;
  raw_html?: string | null;
  raw_json?: string | null;
  last_seen?: string | null;
  [key: string]: unknown;
}

// Loose draft shapes matching the columns used when upserting events/places.
// Most fields are optional; a normalizer fills what it can extract.
export interface EventDraft {
  title: string;
  description?: string | null;
  category?: string | null;
  language?: string | null;
  audience?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  venue_name?: string | null;
  district?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  price?: string | null;
  is_free?: number | null;
  url?: string | null;
  venue_url?: string | null;
  image_url?: string | null;
  source?: string | null;
  source_url?: string | null;
  raw_excerpt?: string | null;
  source_item_id?: number | null;
  tags_json?: string | null;
  metadata_json?: string | null;
  links_json?: string | null;
}

export interface PlaceDraft {
  name: string;
  description?: string | null;
  category?: string | null;
  area?: string | null;
  district?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  price_level?: string | null;
  occasion?: string | null;
  recommended_by?: string | null;
  source?: string | null;
  source_url?: string | null;
  url?: string | null;
  maps_url?: string | null;
  image_url?: string | null;
  rating?: string | null;
  notes?: string | null;
  source_item_id?: number | null;
  tags_json?: string | null;
  metadata_json?: string | null;
}

export type NormalizedStatus = "normalized" | "ignored" | "error";

export interface NormalizedOut {
  events?: EventDraft[];
  places?: PlaceDraft[];
  status: NormalizedStatus;
  note?: string;
}

// A normalizer: given a raw row it persists its events/places (today the
// Hemisfèric normalizer writes directly) and returns the resulting status.
export type Normalizer = (item: RawItem) => Promise<NormalizedOut> | NormalizedOut;

// Record normalization bookkeeping on a `source_items` row. Append-only: this
// only UPDATEs the normalized_* columns and NEVER deletes the raw row
// (constitution I). DB-agnostic — accepts an injectable sql executor so it can
// be unit-tested without a live connection (defaults to the real client).
export async function markRawItem(
  itemId: number,
  status: NormalizedStatus,
  note?: string | null,
  exec: typeof sql = sql,
): Promise<void> {
  const ts = nowIso();
  await exec`UPDATE source_items
    SET normalized_at = ${ts}, normalized_status = ${status}, normalized_note = ${note ?? null}
    WHERE id = ${itemId}`;
}

// Display-layer tag hygiene (T189). The DB stores raw tags that mix three kinds of
// noise alongside real human tags:
//   (a) system / internal tags — "has image", "mapped", "place", and prefixed slugs
//       (tg:/area:/city:/from:/source: and source-key prefixes web:/api:/tg:). These
//       are pipeline bookkeeping, never meant for the UI.
//   (b) garbage price / menu dumps — a tag that is mostly digits + punctuation
//       ("4 95 6 5 50 fried chicken …", "99 5", "tris di focacce 16 99 …"), an artifact
//       of a normalizer that swept a menu line into the tag list.
// cleanTags() DROPS both and keeps the short, human tags ("bbq", "food", "acai bowls",
// "family", "basilica"). Pure + deterministic (T140, no LLM) — applied at the render
// layer in lib/queries.ts; the underlying tag data is untouched.
//
// Tags arrive in two surface forms: slug form ("has-image", "tg-logunespa",
// "city:valencia", "area:camp-de-morvedre") and the humanizeTag()-rendered spaced form
// ("has image", "tg logunespa", "city valencia"). cleanTags runs on the RAW stored tag,
// so it normalizes BOTH `-` and ` ` separators before matching the system patterns.

const MAX_TAG_LEN = 28;
const MAX_DIGIT_RATIO = 0.35;

// Exact system labels (after `-`→` ` normalization, lowercased).
const SYSTEM_EXACT = new Set(["has image", "mapped", "place"]);

// Prefix patterns for internal/namespaced tags. Matched against BOTH the ":"-delimited
// raw form and the " "-normalized form, so "city:valencia", "city valencia",
// "area:camp-de-morvedre" and "area camp de morvedre" all drop. The source-key prefixes
// web:/api:/tg: cover source-key-looking tags (e.g. "web:fever", "tg:logunespa").
const SYSTEM_PREFIXES = [
  "tg ", "tg:",
  "area:", "area ",
  "city ", "city:",
  "district ", "district:",
  "from:", "from ",
  "source:", "source ",
  "web:", "api:",
];

// A tag that is ENTIRELY digits/punctuation/whitespace ("99 5", "4 5013 10 …", "16,99").
const PURE_NUMERIC_RE = /^[\d\s.,;:–—\-/]+$/;

function digitRatio(s: string): number {
  if (!s) return 0;
  let digits = 0;
  for (const ch of s) if (ch >= "0" && ch <= "9") digits++;
  return digits / s.length;
}

// True iff this single tag is noise (system/internal OR a numeric/price-menu dump).
export function isNoiseTag(tag: string): boolean {
  const raw = (tag || "").trim();
  if (!raw) return true;
  // Normalize the slug form to spaced/lowercased for the system-label checks.
  const norm = raw.replace(/-/g, " ").toLowerCase().trim();
  if (SYSTEM_EXACT.has(norm)) return true;
  // Prefix checks run against BOTH the raw (": "-delimited) and normalized forms.
  const rawLower = raw.toLowerCase();
  for (const p of SYSTEM_PREFIXES) {
    if (norm.startsWith(p) || rawLower.startsWith(p)) return true;
  }
  // Garbage: pure numeric/punctuation, too digit-heavy, or too long to be a real tag.
  if (PURE_NUMERIC_RE.test(norm)) return true;
  if (digitRatio(norm) > MAX_DIGIT_RATIO) return true;
  if (norm.length > MAX_TAG_LEN) return true;
  return false;
}

// Drop noise tags, preserving order + dedup-free input (callers already dedup upstream).
export function cleanTags(tags: string[]): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => !isNoiseTag(t));
}

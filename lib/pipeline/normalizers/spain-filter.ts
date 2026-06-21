// Spain-only pre-filter for tour-afisha channels (e.g. tg:concerten) that announce
// RU-artist tours across ALL of Europe (T131). Without it the feed overloads with
// Berlin/Paris/Lisbon dates the family can't attend. Keep an item ONLY when it carries
// an explicit Spain signal (ES or RU spelling of a Spanish city / region / "España").
// Pure + unit-testable; the concerten normalizer calls this before emitting events.

// Spanish cities/regions, ES + RU stems (substring match, lower-cased).
const SPAIN_SIGNALS = [
  "valencia", "valència", "валенси",
  "madrid", "мадрид",
  "barcelona", "барселон",
  "sevilla", "севиль",
  "malaga", "málaga", "малаг",
  "bilbao", "бильбао",
  "zaragoza", "сарагос",
  "alicante", "alacant", "аликанте",
  "murcia", "мурси",
  "granada", "гранад",
  "gandia", "gandía", "гандия",
  "castellon", "castellón", "кастельон",
  "torrevieja", "торревьех",
  "marbella", "марбель",
  "palma", "пальма", "mallorca", "майорк",
  "tenerife", "тенериф", "canaria", "канар", "canarias",
  "españa", "espana", "spain", "испани",
  // Latin transliterations of Spanish cities used in worldafisha URL slugs and many
  // RU posts (T153). Kept tight + Spain-only — each is an unambiguous Spanish place.
  // (madrid/malaga/bilbao already match their ES spelling above.)
  "valensi",   // valensiya → Valencia
  "barselon",  // barselona → Barcelona
  "alikante",  // alikante → Alicante
  "marbel",    // marbelya → Marbella
  "sevil",     // sevilya → Sevilla
  "saragos",   // saragosa → Zaragoza
  "tenerif",   // tenerife (Latin, no final e) → Tenerife
];

// Clearly-non-Spain hubs common in these tours (for diagnostics / a stricter mode).
const NON_SPAIN_SIGNALS = [
  "berlin", "берлин", "paris", "париж", "london", "лондон", "lisboa", "lisbon", "лиссабон",
  "amsterdam", "амстердам", "munich", "münchen", "мюнхен", "milano", "milan", "милан",
  "roma", "rome", "рим", "praha", "prague", "прага", "wien", "vienna", "вена",
  "warszawa", "warsaw", "варшав", "budapest", "будапешт", "frankfurt", "франкфурт",
  "hamburg", "гамбург", "brussels", "брюссель", "zurich", "zürich", "цюрих",
  "tallinn", "таллин", "riga", "рига", "vilnius", "вильнюс", "helsinki", "хельсинки",
  "porto", "порту", "antalya", "анталь", "istanbul", "стамбул", "tbilisi", "тбилиси",
  "yerevan", "ереван", "almaty", "алматы", "dubai", "дубай", "limassol", "лимассол",
];

const has = (t: string, list: string[]) => list.some((k) => t.includes(k));

// T172 — canonical Spanish-city resolution. Several RU-afisha sources (worldafisha,
// valenciarusa) hard-coded `city: "Valencia"` even when the listing was for Alicante or
// Barcelona (the city lives only in the URL slug / title, e.g. `-alikante-` or "в
// Аликанте"). Mapping is ordered MOST-SPECIFIC-FIRST and matches ES + RU + Latin-translit
// stems; the FIRST city whose stem appears in the haystack wins. Returns null when no
// non-default Spanish city is recognised — the caller then keeps its own default
// (typically "Valencia"), so a plain Valencia listing is unchanged.
const CITY_STEMS: Array<[string, string[]]> = [
  ["Alicante", ["alikante", "alicante", "alacant", "аликанте"]],
  ["Barcelona", ["barselon", "barcelona", "барселон"]],
  ["Madrid", ["madrid", "мадрид"]],
  ["Sevilla", ["sevil", "sevilla", "севиль"]],
  ["Malaga", ["málaga", "malaga", "малаг"]],
  ["Bilbao", ["bilbao", "бильбао"]],
  ["Zaragoza", ["saragos", "zaragoza", "сарагос"]],
  ["Murcia", ["murcia", "мурси"]],
  ["Granada", ["granada", "гранад"]],
  ["Castellon", ["castellón", "castellon", "кастельон"]],
  ["Marbella", ["marbel", "marbella", "марбель"]],
  ["Tenerife", ["tenerif", "tenerife", "тенериф"]],
  ["Valencia", ["valensi", "valència", "valencia", "валенси"]],
];

// PURE (T172): best-effort canonical Spanish city from free text / a URL slug. Returns
// the FIRST city (most-specific-first order) whose stem is present, or null when none is
// found. Note that Valencia is LAST so an Alicante/Barcelona listing that also says
// "Валенсия Русская" (the channel name) still resolves to the real venue city.
export function deriveSpanishCity(text?: string | null): string | null {
  const t = (text || "").toLowerCase();
  if (!t) return null;
  let best: { city: string; index: number } | null = null;
  for (const [city, stems] of CITY_STEMS) {
    for (const stem of stems) {
      const idx = t.indexOf(stem);
      if (idx >= 0 && (!best || idx < best.index)) best = { city, index: idx };
    }
  }
  return best ? best.city : null;
}

// PURE: does the text mention Spain (a Spanish city/region/country)?
export function hasSpainSignal(text?: string | null): boolean {
  return has((text || "").toLowerCase(), SPAIN_SIGNALS);
}

// PURE: does it mention a clearly non-Spain hub?
export function hasNonSpainSignal(text?: string | null): boolean {
  return has((text || "").toLowerCase(), NON_SPAIN_SIGNALS);
}

// PURE: keep this tour item? Conservative for a Europe-wide channel — keep ONLY when
// Spain is explicitly mentioned (drops non-Spain and location-less noise → no overload).
export function isSpainEvent(text?: string | null): boolean {
  return hasSpainSignal(text);
}

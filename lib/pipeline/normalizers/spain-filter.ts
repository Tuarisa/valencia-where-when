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

// Canonical category keys + RU display labels (T178). The raw `events.category`
// vocabulary mixes EN/RU, singular/plural, and casing (concert/Concert/concerts,
// концерт/Концерты, exhibition/выставка, theatre/театр, …) which produced ~41
// near-duplicate filter chips. This module collapses every variant to ONE canonical
// RU key so the chip bar shows ~8-12 clean chips.
//
// DB-FREE + PURE: imported by a CLIENT component (app/Home.tsx) AND by lib/queries.ts.
// It must NOT import lib/db (that would pull server code into the client bundle).
// Deterministic — no LLM (T140): a fixed synonym/plural map, lowercase + trim.
//
// MAPPING (measured 2026-06-23 on the live upcoming feed, 41 distinct → 10 canonical):
//   концерт   ← concert(s)/Concert, концерт(ы)/Концерт(ы), music/Music/музыка/Музыка,
//               jazz/Джаз, "Концерты и музыка", "Музыка и театр" (music+concert are one
//               bucket for this afisha — see note below)
//   театр     ← theatre/театр, Балет (ballet folds into theatre)
//   выставка  ← exhibition/выставка/Выставка, "выставка / корабль-музей"
//   кино      ← cinema/film/кино/Кино
//   фестиваль ← festival/Festival/фестиваль, праздник/Праздник(и), gastronomy/
//               "Гастрономический фестиваль", fireworks/фейерверк (holiday/festival/
//               gastronomy/fireworks bucket — folded into one clean chip)
//   развлечения ← entertainment/show/развлечения/Развлечения
//   культура  ← culture/культура (generic — the biggest bucket; kept as its own)
//   экскурсия ← excursion/экскурсия (guided day-tours, its own accent in the calendar)
//   лекция    ← лекция/lecture
//   стендап   ← stand-up/стендап
// Unknown raw values fall back to their lowercased/trimmed selves (still filterable).
//
// EDGE-BUCKET DECISIONS (documented per the task brief):
//   • music + concert → ONE bucket "концерт" — this afisha treats live music and
//     concerts as the same thing; keeping them split produced two near-identical chips.
//   • "Музыка и театр" → концерт (it leads with музыка; the брief allowed either —
//     chose концерт to keep театр a pure theatre/ballet bucket).
//   • Балет → театр (ballet is a stage performance, no separate ballet chip warranted).
//   • праздник / fireworks / gastronomy → folded into фестиваль (one clean celebration
//     bucket rather than three single-count chips).

// Synonym → canonical-key map. Keys are lowercased+trimmed raw category strings.
const CATEGORY_SYNONYMS: Record<string, string> = {
  // концерт (concerts + live music)
  concert: "концерт",
  concerts: "концерт",
  концерт: "концерт",
  концерты: "концерт",
  music: "концерт",
  музыка: "концерт",
  "концерты и музыка": "концерт",
  "музыка и театр": "концерт",
  jazz: "концерт",
  джаз: "концерт",
  // театр (theatre + ballet)
  theatre: "театр",
  theater: "театр",
  театр: "театр",
  балет: "театр",
  ballet: "театр",
  // выставка
  exhibition: "выставка",
  выставка: "выставка",
  "выставка / корабль-музей": "выставка",
  expo: "выставка",
  // кино
  cinema: "кино",
  film: "кино",
  кино: "кино",
  // фестиваль (festival / holiday / gastronomy / fireworks)
  festival: "фестиваль",
  фестиваль: "фестиваль",
  праздник: "фестиваль",
  праздники: "фестиваль",
  holiday: "фестиваль",
  gastronomy: "фестиваль",
  "гастрономический фестиваль": "фестиваль",
  fireworks: "фестиваль",
  фейерверк: "фестиваль",
  фейерверки: "фестиваль",
  // развлечения
  entertainment: "развлечения",
  show: "развлечения",
  развлечения: "развлечения",
  // культура (generic)
  culture: "культура",
  культура: "культура",
  // экскурсия
  excursion: "экскурсия",
  экскурсия: "экскурсия",
  экскурсии: "экскурсия",
  // лекция
  lecture: "лекция",
  лекция: "лекция",
  лекции: "лекция",
  // стендап
  "stand-up": "стендап",
  standup: "стендап",
  стендап: "стендап",
  // прочие частые RU/EN
  семейные: "семейные",
  family: "семейные",
  дети: "детям",
  kids: "детям",
  детям: "детям",
  sport: "спорт",
  спорт: "спорт",
  food: "еда",
  еда: "еда",
  party: "вечеринки",
  вечеринки: "вечеринки",
  education: "образование",
  образование: "образование",
  market: "ярмарки",
  ярмарки: "ярмарки",
  other: "другое",
  другое: "другое",
};

// Collapse a raw category to its canonical RU key. Lowercase + trim, then look up the
// synonym map. Unknown values fall back to the lowercased+trimmed raw (still filterable,
// just not merged). Returns "" for null/blank input. PURE.
export function canonicalCategory(raw: string | null | undefined): string {
  const key = (raw || "").trim().toLowerCase();
  if (!key) return "";
  if (CATEGORY_SYNONYMS[key]) return CATEGORY_SYNONYMS[key];
  // Lightweight plural fold for unmapped Russian plurals (ы/и → singular) so a stray
  // unmapped plural doesn't spawn its own chip next to the singular fallback.
  if (key.length > 4) {
    const singular = key.replace(/(ы|и)$/u, "");
    if (singular !== key && CATEGORY_SYNONYMS[singular]) return CATEGORY_SYNONYMS[singular];
  }
  return key;
}

// Display label for a canonical category key. The keys are already RU, so just
// capitalize the first character. PURE. (Replaces the old CATEGORY_RU map in Home.tsx.)
export function categoryLabelRu(key: string): string {
  const k = (key || "").trim();
  if (!k) return "";
  return k[0].toUpperCase() + k.slice(1);
}

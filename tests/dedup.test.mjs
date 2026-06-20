import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of lib/pipeline/dedup.ts (research D2 / data-model
// "Dedup match & merge"). No DB: the same `dedupKey` / `chooseSurvivor` /
// `mergeGroup` contracts are exercised against three in-memory records for ONE
// real concert (Слава Комиссаренко) listed by three sources with CONFLICTING
// dates and differing titles. Mirrors the TS so the test stays DB-free while
// asserting the invariants the module guarantees.

// --- mirror of slugify (lib/format.ts): NFKD ascii-fold, non-alnum → "-" ---
function slugify(value) {
  if (!value) return '';
  const ascii = String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .trim();
  return ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const SOURCE_WEIGHT_RANK = { gold: 3, good: 2, mine: 1, off: 0 };
function sourceWeightRank(weight) {
  if (!weight) return 0;
  const r = SOURCE_WEIGHT_RANK[weight];
  return typeof r === 'number' ? r : 0;
}

const WINDOW = 3;
const TITLE_STOPWORDS = new Set([
  'stand', 'up', 'standup', 'show', 'concierto', 'concert', 'concerto',
  'en', 'in', 'v', 'de', 'la', 'el', 'los', 'las', 'y', 'and',
  'valencia', 'valensii', 'valensiya', 'espectaculo', 'live',
  'stendap', 'standap', 'kontsert', 'kontserty', 'shou', 'spektakl', 'vecher', 'na',
]);

const RU_TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
function transliterate(value) {
  if (!value) return '';
  let out = '';
  for (const ch of String(value).toLowerCase()) out += RU_TRANSLIT[ch] ?? ch;
  return out;
}

function titleSignature(title) {
  const slug = slugify(transliterate(title));
  if (!slug) return 'untitled';
  const tokens = slug.split('-').filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t));
  if (tokens.length === 0) return slug;
  return tokens.sort().join('-');
}

function distinctSourceCount(group) {
  const seen = new Set();
  for (const ev of group) if (typeof ev.source === 'string' && ev.source) seen.add(ev.source);
  return seen.size;
}
function isMergeableGroup(group) {
  if (group.length < 2) return false;
  if (titleSignature(group[0]?.title) === 'untitled') return false;
  return distinctSourceCount(group) >= 2;
}

function epochDay(startDate) {
  if (!startDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(startDate);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

function dedupKey(event) {
  const sig = titleSignature(event.title);
  const city = slugify(event.city) || 'unknown';
  return `${sig}|${city}`;
}

function groupByKey(events, windowDays = WINDOW) {
  const clusters = new Map();
  for (const ev of events) {
    const key = dedupKey(ev);
    const bucket = clusters.get(key);
    if (bucket) bucket.push(ev);
    else clusters.set(key, [ev]);
  }
  const groups = new Map();
  for (const [key, members] of clusters) {
    const sorted = [...members].sort((a, b) => {
      const da = epochDay(a.start_date);
      const db = epochDay(b.start_date);
      if (da == null && db == null) return 0;
      if (da == null) return -1;
      if (db == null) return 1;
      return da - db;
    });
    let sub = 0;
    let anchor = null;
    let current = [];
    const flush = () => {
      if (current.length) groups.set(`${key}|${sub++}`, current);
    };
    for (const ev of sorted) {
      const d = epochDay(ev.start_date);
      if (current.length === 0) {
        current = [ev];
        anchor = d;
      } else if (d == null || anchor == null || Math.abs(d - anchor) <= windowDays) {
        current.push(ev);
        if (anchor == null) anchor = d;
      } else {
        flush();
        current = [ev];
        anchor = d;
      }
    }
    flush();
  }
  return groups;
}

function chooseSurvivor(group, rankFn = sourceWeightRank) {
  let best = group[0];
  let bestRank = rankFn(best.source_weight);
  let bestScore = best.score ?? 0;
  for (let i = 1; i < group.length; i++) {
    const cand = group[i];
    const r = rankFn(cand.source_weight);
    const s = cand.score ?? 0;
    if (r > bestRank || (r === bestRank && s > bestScore)) {
      best = cand;
      bestRank = r;
      bestScore = s;
    }
  }
  return best;
}

function parseMetadata(metadata) {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function accumulateSources(group, existing) {
  const out = [];
  const seen = new Set();
  const add = (source, url) => {
    const s = typeof source === 'string' && source ? source : null;
    const u = typeof url === 'string' && url ? url : null;
    if (s == null && u == null) return;
    const k = `${s ?? ''}|${u ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ source: s, source_url: u });
  };
  if (Array.isArray(existing)) {
    for (const e of existing) if (e && typeof e === 'object') add(e.source, e.source_url);
  }
  for (const ev of group) add(ev.source, ev.source_url);
  return out;
}

function mergeGroup(group, rankFn = sourceWeightRank) {
  const survivor = chooseSurvivor(group, rankFn);
  const metadata = parseMetadata(survivor.metadata_json);
  const mergedSources = accumulateSources(group, metadata.sources);
  metadata.sources = mergedSources;
  const mergedSurvivor = { ...survivor, metadata_json: JSON.stringify(metadata) };
  const losers = group.filter((ev) => ev !== survivor);
  return { survivor: mergedSurvivor, mergedSources, losers };
}

// --- Fixture: ONE concert, three sources, conflicting dates + titles ---
const records = [
  {
    id: 1,
    // RU Telegram channel: artist name transliterated, generic "stand-up" suffix.
    title: 'Slava Komissarenko — стендап в Валенсии',
    city: 'Valencia',
    start_date: '2026-07-11', // WRONG date (Telegram channel, low weight)
    score: 40,
    source: 'valenciarusa',
    source_url: 'https://t.me/valenciarusa/123',
    source_weight: 'mine',
  },
  {
    id: 2,
    // Aggregator: reordered name, "Stand-up" framing word, different city phrasing.
    title: 'Komissarenko Slava. Stand-up Show',
    city: 'Valencia',
    start_date: '2026-07-10', // RELIABLE date (gold, high score)
    score: 80,
    source: 'worldafisha',
    source_url: 'https://worldafisha.com/event/komissarenko',
    source_weight: 'gold',
  },
  {
    id: 3,
    // Ticketing: "Stand Up:" prefix + name.
    title: 'Stand Up: Slava Komissarenko',
    city: 'Valencia',
    start_date: '2026-07-12', // ANOTHER wrong date (good weight)
    score: 60,
    source: 'concerten',
    source_url: 'https://concerten.com/komissarenko',
    source_weight: 'good',
  },
];

test('(a) the three conflicting-date records share one dedupKey / group', () => {
  const keys = new Set(records.map((r) => dedupKey(r)));
  assert.equal(keys.size, 1, 'all three records must produce the same dedupKey');
  const groups = groupByKey(records);
  assert.equal(groups.size, 1, 'exactly one group');
  assert.equal([...groups.values()][0].length, 3, 'group holds all three records');
});

test('(b) chooseSurvivor picks highest weight+score with the reliable date', () => {
  const survivor = chooseSurvivor(records);
  assert.equal(survivor.id, 2, 'gold/score-80 record wins');
  assert.equal(survivor.source_weight, 'gold');
  assert.equal(survivor.start_date, '2026-07-10', 'survivor keeps its own reliable date');
});

test('(c) mergeGroup survivor.metadata_json.sources[] lists all three sources', () => {
  const { survivor, mergedSources } = mergeGroup(records);
  const sources = JSON.parse(survivor.metadata_json).sources;
  assert.equal(sources.length, 3, 'all three sources accumulated');
  assert.deepEqual(mergedSources, sources);
  const urls = sources.map((s) => s.source_url).sort();
  assert.deepEqual(urls, [
    'https://concerten.com/komissarenko',
    'https://t.me/valenciarusa/123',
    'https://worldafisha.com/event/komissarenko',
  ]);
  // survivor's own date is unchanged by the merge
  assert.equal(survivor.start_date, '2026-07-10');
});

test('(d) mergeGroup returns exactly two losers', () => {
  const { survivor, losers } = mergeGroup(records);
  assert.equal(losers.length, 2);
  assert.ok(!losers.some((l) => l.id === survivor.id), 'survivor is not among losers');
  assert.deepEqual(losers.map((l) => l.id).sort(), [1, 3]);
});

test('sources accumulation de-duplicates and preserves existing entries', () => {
  const withExisting = [
    {
      id: 9,
      title: 'Слава Комиссаренко',
      city: 'Valencia',
      start_date: '2026-07-10',
      score: 90,
      source: 'worldafisha',
      source_url: 'https://worldafisha.com/event/komissarenko',
      source_weight: 'gold',
      metadata_json: JSON.stringify({
        sources: [{ source: 'worldafisha', source_url: 'https://worldafisha.com/event/komissarenko' }],
      }),
    },
    records[0],
  ];
  const { mergedSources } = mergeGroup(withExisting);
  // existing worldafisha link not duplicated; valenciarusa added
  assert.equal(mergedSources.length, 2);
});

test('Cyrillic titles get real, distinct signatures (no "untitled" collapse)', () => {
  // The bug: slugify strips Cyrillic → "untitled" → all RU events grouped as one.
  assert.notEqual(titleSignature('Моргенштерн'), 'untitled');
  assert.notEqual(titleSignature('Антон Лирник'), 'untitled');
  assert.notEqual(
    titleSignature('Моргенштерн'),
    titleSignature('Антон Лирник'),
    'two different RU artists must NOT share a signature',
  );
  // Cyrillic matches its Latin transliteration (cross-script dedup).
  assert.equal(
    titleSignature('Слава Комиссаренко'),
    titleSignature('Slava Komissarenko'),
  );
});

test('isMergeableGroup: cross-source merges, same-source/untitled do not', () => {
  // Komissarenko = 3 DISTINCT sources → a genuine cross-source duplicate.
  assert.equal(isMergeableGroup(records), true);

  // Same recurring show on consecutive days from ONE source → occurrences, not dups.
  const recurringSameSource = [
    { id: 1, title: '3, 2, 1... ¡Despegamos!', city: 'Valencia', start_date: '2026-06-22', source: 'cac' },
    { id: 2, title: '3, 2, 1... ¡Despegamos!', city: 'Valencia', start_date: '2026-06-23', source: 'cac' },
  ];
  assert.equal(isMergeableGroup(recurringSameSource), false, 'same-source repeats must not merge');

  // Degenerate signature → never merge even across sources.
  const untitled = [
    { id: 1, title: '«»', city: 'Valencia', start_date: '2026-07-01', source: 'a' },
    { id: 2, title: '!!!', city: 'Valencia', start_date: '2026-07-01', source: 'b' },
  ];
  assert.equal(isMergeableGroup(untitled), false, 'untitled signature must not merge');
});

test('T136: worldafisha ≈ concerten PAIR — same RU-artist tour merges, both source links kept', () => {
  // Both sources are the SAME "Зарубежная афиша" RU-artist-tours feed, so they list
  // the SAME concert. Real source keys (web:worldafisha id 9, tg:concerten id 2). This
  // proves the EXACT T136 scenario: the PAIR alone (no third source helping) is enough
  // to merge — distinctSourceCount ≥ 2 — and the survivor keeps BOTH source links
  // (constitution: dedup keeps a link to every source, never drops one).
  const pair = [
    {
      id: 901,
      title: 'Баста — концерт в Валенсии', // worldafisha framing
      city: 'Valencia',
      start_date: '2026-10-04',
      score: 70,
      source: 'web:worldafisha',
      source_url: 'https://worldafisha.com/events/ispaniya/basta',
      source_weight: 'good',
    },
    {
      id: 902,
      title: 'Баста. Концерт', // concerten framing (same tour, terser title)
      city: 'Valencia',
      start_date: '2026-10-05', // ±1 day — within the date window
      score: 50,
      source: 'tg:concerten',
      source_url: 'https://t.me/concerten/456',
      source_weight: 'mine',
    },
  ];

  // (1) both framings collapse to one signature/group
  assert.equal(new Set(pair.map((r) => dedupKey(r))).size, 1, 'same dedupKey despite title framing differences');
  const groups = groupByKey(pair);
  assert.equal(groups.size, 1, 'exactly one group');

  // (2) the 2-source PAIR is mergeable on its own (≥2 distinct sources)
  assert.equal(distinctSourceCount(pair), 2);
  assert.equal(isMergeableGroup(pair), true, 'two distinct overlapping feeds → merge');

  // (3) survivor keeps BOTH source links (every source preserved)
  const { survivor, losers } = mergeGroup(pair);
  const urls = JSON.parse(survivor.metadata_json).sources.map((s) => s.source_url).sort();
  assert.deepEqual(urls, [
    'https://t.me/concerten/456',
    'https://worldafisha.com/events/ispaniya/basta',
  ]);
  // (4) exactly one loser; the higher-weight worldafisha row survives with its date
  assert.equal(losers.length, 1);
  assert.equal(survivor.id, 901, 'higher-weight (good > mine) survives');
  assert.equal(survivor.start_date, '2026-10-04');
});

// ---------- Places dedup primitives (mirror of lib/pipeline/dedup.ts T036/T037) ----------
function jaroWinkler(a, b) {
  const s1 = a ?? '';
  const s2 = b ?? '';
  if (s1 === s2) return s1.length ? 1 : 0;
  if (!s1.length || !s2.length) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const s1m = new Array(s1.length).fill(false);
  const s2m = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, s2.length);
    for (let j = lo; j < hi; j++) {
      if (s2m[j] || s1[i] !== s2[j]) continue;
      s1m[i] = true; s2m[j] = true; matches++; break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0; let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1m[i]) continue;
    while (!s2m[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  const m = matches;
  const jaro = (m / s1.length + m / s2.length + (m - transpositions) / m) / 3;
  let prefix = 0;
  const maxPrefix = Math.min(4, s1.length, s2.length);
  for (let i = 0; i < maxPrefix; i++) { if (s1[i] === s2[i]) prefix++; else break; }
  return jaro + prefix * 0.1 * (1 - jaro);
}
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const CENTROID_BLACKLIST = [[40.4168, -3.7035], [39.4697065, -0.3763353]];
function isCentroid(lat, lng) {
  if (lat == null || lng == null) return false;
  return CENTROID_BLACKLIST.some(([cla, clo]) => haversineMeters(lat, lng, cla, clo) <= 60);
}
function geoCorroborates(a, b, r = 100) {
  if (a.geo_source !== 'map_url' || b.geo_source !== 'map_url') return false;
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return false;
  if (isCentroid(a.lat, a.lng) || isCentroid(b.lat, b.lng)) return false;
  return haversineMeters(a.lat, a.lng, b.lat, b.lng) <= r;
}
const normName = (n) => slugify(transliterate(n));
function placeKey(p) {
  const sig = titleSignature(p.name);
  const area = slugify(p.area || p.district) || 'unknown';
  const cat = slugify(p.category) || 'unknown';
  return `${sig}|${area}|${cat}`;
}
function arePlacesDuplicate(a, b, tau = 0.9) {
  if (a === b) return false;
  const am = (a.maps_url || '').trim().toLowerCase();
  const bm = (b.maps_url || '').trim().toLowerCase();
  if (am && bm && am === bm) return true;
  if (a.external_ref && b.external_ref && a.source && a.source === b.source && a.external_ref === b.external_ref) return true;
  if (placeKey(a) !== placeKey(b)) return false;
  if (jaroWinkler(normName(a.name), normName(b.name)) < tau) return false;
  const cross = !!(a.source && b.source && a.source !== b.source);
  return cross || geoCorroborates(a, b);
}

test('jaroWinkler: known values + edge cases', () => {
  assert.ok(jaroWinkler('martha', 'marhta') > 0.95);
  assert.equal(jaroWinkler('abc', 'abc'), 1);
  assert.equal(jaroWinkler('', 'x'), 0);
  assert.equal(jaroWinkler('abc', 'xyz'), 0);
  assert.ok(jaroWinkler('bar pepe', 'bar pepe!') > 0.9);
});

test('haversineMeters + isCentroid', () => {
  assert.equal(haversineMeters(39.46, -0.37, 39.46, -0.37), 0);
  const oneDeg = haversineMeters(0, 0, 0, 1);
  assert.ok(oneDeg > 111000 && oneDeg < 111400, 'one degree lng at equator ~111.2km');
  assert.equal(isCentroid(40.4168, -3.7035), true, 'Madrid Sol is blacklisted');
  assert.equal(isCentroid(39.4697065, -0.3763353), true, 'Valencia fallback is blacklisted');
  assert.equal(isCentroid(39.4631, -0.3734), false, 'a real Ruzafa venue is not a centroid');
});

test('geoCorroborates: only map_url pins vote, centroid-guarded', () => {
  const near = { lat: 39.46, lng: -0.37, geo_source: 'map_url' };
  const near2 = { lat: 39.4601, lng: -0.37, geo_source: 'map_url' }; // ~11m
  const far = { lat: 39.47, lng: -0.37, geo_source: 'map_url' }; // ~1.1km
  assert.equal(geoCorroborates(near, near2), true, 'two map_url pins within 100m corroborate');
  assert.equal(geoCorroborates(near, far), false, 'beyond radius does not corroborate');
  assert.equal(
    geoCorroborates({ ...near, geo_source: 'nominatim' }, { ...near2, geo_source: 'nominatim' }),
    false,
    'nominatim coords never vote (even at 0m)',
  );
  const sol = { lat: 40.4168, lng: -3.7035, geo_source: 'map_url' };
  assert.equal(geoCorroborates(sol, { ...sol }), false, 'blacklisted centroid never corroborates');
});

test('arePlacesDuplicate: distinct venues on a fallback centroid do NOT merge', () => {
  // Seed places 10/11/12 — three different unresolved maps links stacked on the
  // Madrid Puerta del Sol fallback (geo_source=nominatim, category=place).
  const sol = (id) => ({
    id, name: `https://maps.app.goo.gl/${id}abc`, area: null, category: 'place',
    lat: 40.416782, lng: -3.703507, geo_source: 'nominatim', maps_url: `https://maps.app.goo.gl/${id}abc`, source: 'tg:logunespa',
  });
  assert.equal(arePlacesDuplicate(sol(10), sol(11)), false);
  assert.equal(arePlacesDuplicate(sol(11), sol(12)), false);
  // Seed places 4/7/8 — pool vs cafe vs bar stacked on the València fallback.
  const p4 = { id: 4, name: 'Piscina Parc de l’Oest', category: 'pool', lat: 39.4697065, lng: -0.3763353, geo_source: 'nominatim', maps_url: 'https://maps.app.goo.gl/p4', source: 'a' };
  const p7 = { id: 7, name: 'https://maps.app.goo.gl/p7', category: 'cafe', lat: 39.4697065, lng: -0.3763353, geo_source: 'nominatim', maps_url: 'https://maps.app.goo.gl/p7', source: 'b' };
  assert.equal(arePlacesDuplicate(p4, p7), false, 'pool vs cafe at identical fallback coords must not merge');
});

test('arePlacesDuplicate: genuine duplicates DO merge', () => {
  // Strong-match: identical maps_url.
  assert.equal(
    arePlacesDuplicate(
      { id: 1, name: 'A', maps_url: 'https://maps.app.goo.gl/SAME', source: 'a' },
      { id: 2, name: 'totally different label', maps_url: 'https://maps.app.goo.gl/SAME', source: 'a' },
    ),
    true,
  );
  // Fuzzy cross-source: same name/area/category from two channels.
  assert.equal(
    arePlacesDuplicate(
      { id: 1, name: 'Bar Pepe', area: 'Ruzafa', category: 'bar', source: 'tg:logunespa' },
      { id: 2, name: 'Bar Pepe', area: 'Ruzafa', category: 'bar', source: 'tg:rutatuta_vlc' },
    ),
    true,
  );
  // Fuzzy + geo: same name, same source, two map_url pins ~11m apart.
  assert.equal(
    arePlacesDuplicate(
      { id: 1, name: 'Cafe Luna', area: 'x', category: 'cafe', source: 's', lat: 39.46, lng: -0.37, geo_source: 'map_url' },
      { id: 2, name: 'Cafe Luna', area: 'x', category: 'cafe', source: 's', lat: 39.4601, lng: -0.37, geo_source: 'map_url' },
    ),
    true,
  );
});

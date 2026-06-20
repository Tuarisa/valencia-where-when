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
]);

function titleSignature(title) {
  const slug = slugify(title);
  if (!slug) return 'untitled';
  const tokens = slug.split('-').filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t));
  if (tokens.length === 0) return slug;
  return tokens.sort().join('-');
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

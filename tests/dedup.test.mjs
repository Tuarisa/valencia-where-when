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

// T185 mirror: gap-fill end_date from the loser with the furthest-future span.
function hasEndDate(v) {
  return typeof v === 'string' && v.trim() !== '';
}
function inheritEndDate(survivor, losers) {
  if (hasEndDate(survivor.end_date)) return null;
  let best = null;
  for (const loser of losers) {
    if (hasEndDate(loser.end_date) && (best == null || loser.end_date > best)) best = loser.end_date;
  }
  return best;
}

function mergeGroup(group, rankFn = sourceWeightRank) {
  const survivor = chooseSurvivor(group, rankFn);
  const metadata = parseMetadata(survivor.metadata_json);
  const mergedSources = accumulateSources(group, metadata.sources);
  metadata.sources = mergedSources;
  const losers = group.filter((ev) => ev !== survivor);
  const mergedSurvivor = { ...survivor, metadata_json: JSON.stringify(metadata) };
  // T185: only fill when the survivor's own end_date is null/empty (never overwrite).
  const inherited = inheritEndDate(mergedSurvivor, losers);
  if (inherited != null) mergedSurvivor.end_date = inherited;
  return { survivor: mergedSurvivor, mergedSources, losers };
}

// --- mirror of the T035 strong-match pre-pass (lib/pipeline/dedup.ts) ---
function strongMatchKey(event) {
  const url = (event.url ?? '').trim().toLowerCase().replace(/\/+$/, '');
  if (url) return `url:${url}|${titleSignature(event.title)}|${event.start_date ?? ''}`;
  const ext = typeof event.external_ref === 'string' ? event.external_ref.trim() : '';
  const src = typeof event.source === 'string' ? event.source.trim() : '';
  if (ext) return `ext:${src}|${ext}`;
  return null;
}
// PURE guard (mirror of lib/pipeline/dedup.ts isStrongCollapsible): a strong-key
// collision group collapses only when cross-source (≥2 distinct sources) OR a
// same-source NON-degenerate title (a genuine re-fetch). A same-source "untitled"
// group keyed on a shared url+date would fuse distinct occurrences → released to
// the fuzzy pass instead (where the ≥2-source guard protects it).
function isStrongCollapsible(group) {
  if (group.length < 2) return false;
  if (distinctSourceCount(group) >= 2) return true;
  return titleSignature(group[0]?.title) !== 'untitled';
}

function strongMatchPrePass(events) {
  const groups = new Map();
  const order = [];
  for (const ev of events) {
    const key = strongMatchKey(ev);
    order.push({ key, event: ev });
    if (key == null) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(ev);
    else groups.set(key, [ev]);
  }
  const repFor = new Map();
  const collapses = [];
  const released = new Set();
  for (const [key, members] of groups) {
    if (members.length < 2) { repFor.set(key, members[0]); continue; }
    if (!isStrongCollapsible(members)) { released.add(key); continue; }
    const { survivor, losers } = mergeGroup(members);
    repFor.set(key, survivor);
    for (const loser of losers) collapses.push({ loser, survivorId: survivor.id ?? null });
  }
  const emitted = new Set();
  const survivors = [];
  for (const { key, event } of order) {
    if (key == null || released.has(key)) { survivors.push(event); continue; }
    if (emitted.has(key)) continue;
    emitted.add(key);
    survivors.push(repFor.get(key) ?? event);
  }
  return { survivors, collapses };
}

test('T035 strongMatchKey: url > external_ref, normalised, source-scoped', () => {
  // url wins and is trailing-slash / case normalised; the key also folds in the
  // title signature + start_date so distinct events on one shared page stay apart
  // (untitled + no date → trailing "|untitled|").
  assert.equal(
    strongMatchKey({ url: 'https://X.com/Event/', external_ref: 'abc', source: 's' }),
    'url:https://x.com/event|untitled|',
  );
  // identical canonical url + same (absent) title/date despite case + trailing
  // slash → same key
  assert.equal(
    strongMatchKey({ url: 'https://x.com/event' }),
    strongMatchKey({ url: 'https://X.com/Event/' }),
  );
  // SAME shared page url but DIFFERENT title/date → DIFFERENT keys (the over-merge
  // fix: lacotorra's many events on one snapshot page are NOT collapsed)
  assert.notEqual(
    strongMatchKey({ url: 'https://x.com/page', title: 'Concert A', start_date: '2026-08-01' }),
    strongMatchKey({ url: 'https://x.com/page', title: 'Concert B', start_date: '2026-08-02' }),
  );
  // no url → external_ref, scoped by source (same ext, diff source ≠ collide)
  assert.equal(strongMatchKey({ external_ref: '42', source: 'a' }), 'ext:a|42');
  assert.notEqual(
    strongMatchKey({ external_ref: '42', source: 'a' }),
    strongMatchKey({ external_ref: '42', source: 'b' }),
  );
  // neither → null (falls through to fuzzy)
  assert.equal(strongMatchKey({ title: 'x' }), null);
});

test('T035 strongMatchPrePass: re-fetched url+title+date rows collapse (pre-fuzzy)', () => {
  // Two rows, SAME source, SAME canonical url, SAME title + date — a genuine
  // re-fetch of ONE listing. The strong pre-pass collapses them (the url-only
  // variants differing by case / trailing slash still collide).
  const rows = [
    { id: 1, title: 'Утренник для малышей', city: 'Valencia', start_date: '2026-08-01', score: 30, source: 'web:x', source_url: 'https://t.me/x/1', url: 'https://x.com/e/99', source_weight: 'good' },
    { id: 2, title: 'Утренник для малышей', city: 'Valencia', start_date: '2026-08-01', score: 70, source: 'web:x', source_url: 'https://t.me/x/2', url: 'https://x.com/e/99/', source_weight: 'good' },
    { id: 3, title: 'Unrelated solo event', city: 'Valencia', start_date: '2026-08-09', score: 10, source: 'web:y', source_url: 'https://t.me/y/3', url: 'https://y.com/e/1', source_weight: 'mine' },
  ];
  const { survivors, collapses } = strongMatchPrePass(rows);
  // ids 1+2 collapse (same url+title+date) → one survivor; id 3 passes through
  assert.equal(survivors.length, 2, 'three rows → two survivors after strong collapse');
  assert.equal(collapses.length, 1, 'exactly one loser collapsed');
  // higher score wins the strong group
  const rep = survivors.find((s) => s.url && s.url.startsWith('https://x.com'));
  assert.equal(rep.id, 2, 'higher-score row survives the strong group');
  assert.equal(collapses[0].loser.id, 1);
  assert.equal(collapses[0].survivorId, 2);
  // survivor keeps BOTH source links (every source preserved, constitution)
  const urls = JSON.parse(rep.metadata_json).sources.map((s) => s.source_url).sort();
  assert.deepEqual(urls, ['https://t.me/x/1', 'https://t.me/x/2']);
  // untouched passthrough keeps original identity, original order preserved
  assert.equal(survivors[1].id, 3);
});

test('T141 strongMatchPrePass: distinct events sharing ONE page url are NOT collapsed', () => {
  // Multi-event-per-page sources (lacotorra, eventbrite, hoyvalencia) emit MANY
  // distinct dated events that all carry the SAME listing/snapshot page url. The
  // url-ALONE key collapsed all of them into one (the over-merge bug); folding the
  // title signature + start_date into the key keeps every distinct event apart.
  const page = 'https://lacotorra.es/agenda';
  const rows = [
    { id: 1, title: 'Concierto de Jazz', city: 'Valencia', start_date: '2026-08-01', score: 50, source: 'web:lacotorra', source_url: page, url: page, source_weight: 'good' },
    { id: 2, title: 'Teatro Infantil', city: 'Valencia', start_date: '2026-08-02', score: 50, source: 'web:lacotorra', source_url: page, url: page, source_weight: 'good' },
    { id: 3, title: 'Exposición de Arte', city: 'Valencia', start_date: '2026-08-03', score: 50, source: 'web:lacotorra', source_url: page, url: page, source_weight: 'good' },
    // SAME title but a DIFFERENT date → still a distinct occurrence, distinct key
    { id: 4, title: 'Concierto de Jazz', city: 'Valencia', start_date: '2026-08-08', score: 50, source: 'web:lacotorra', source_url: page, url: page, source_weight: 'good' },
  ];
  const { survivors, collapses } = strongMatchPrePass(rows);
  // ALL four distinct events survive — nothing collapses despite the shared url
  assert.equal(collapses.length, 0, 'no over-merge: distinct events on one page stay apart');
  assert.deepEqual(survivors.map((s) => s.id), [1, 2, 3, 4], 'all four survive, order kept');

  // A TRUE duplicate (same url + same title + same date, two copies) still collapses
  const dupRows = [
    { id: 10, title: 'Concierto de Jazz', city: 'Valencia', start_date: '2026-08-01', score: 30, source: 'web:lacotorra', source_url: page, url: page, source_weight: 'good' },
    { id: 11, title: 'Concierto de Jazz', city: 'Valencia', start_date: '2026-08-01', score: 80, source: 'web:lacotorra', source_url: page, url: page, source_weight: 'good' },
  ];
  const dup = strongMatchPrePass(dupRows);
  assert.equal(dup.survivors.length, 1, 'a genuine re-fetch (same url+title+date) collapses to 1');
  assert.equal(dup.collapses.length, 1);
  assert.equal(dup.survivors[0].id, 11, 'higher-score copy survives');
});

test('T156 feria: same-source recurring concerts at ONE venue/centroid → 0 merges', () => {
  // Real failure (web:feriadejuliovlc): 43 "Conciertos de Viveros / Feria de Julio"
  // events — SAME source, SAME venue ("Jardins de Vivers"), SAME maps URL, all on the
  // València fallback CENTROID (39.476,-0.368), but DISTINCT artists (titles) on
  // DISTINCT nights. These are recurring occurrences of a festival, NOT duplicates.
  // The old url-ALONE strong key collapsed all 43 → 2; the fix (url|titleSignature|
  // start_date key + the ≥2-source guard on EVERY path) keeps every night.
  const URL = 'https://conciertosdeviverosvlc.com';
  const lineup = [
    ['Conciertos de Viveros: Duncan Dhu', '2026-07-02'],
    ['Conciertos de Viveros: Javi Medina', '2026-07-03'],
    ['Conciertos de Viveros: Generación 80-90', '2026-07-04'],
    ['Conciertos de Viveros: Valeria Castro', '2026-07-05'],
    ['Conciertos de Viveros: Danny Ocean', '2026-07-06'],
    ['Conciertos de Viveros: Deep Purple', '2026-07-07'],
    ['Conciertos de Viveros: Garbage', '2026-07-08'],
    ['Conciertos de Viveros: Juan Magán', '2026-07-09'],
  ];
  const rows = lineup.map(([title, start_date], i) => ({
    id: 1001 + i, title, city: 'Valencia', start_date, score: 50,
    source: 'web:feriadejuliovlc', source_url: URL, url: URL,
    // every event pinned to the SAME venue on the centroid fallback coords
    venue_name: 'Jardins de Vivers', lat: 39.476, lng: -0.368, geo_source: 'manual',
    source_weight: 'good',
  }));

  // (1) strong pre-pass: shared url but DISTINCT title+date → distinct strong keys,
  // nothing collapses (the centroid coords play no role — events have no geo path).
  const { survivors, collapses } = strongMatchPrePass(rows);
  assert.equal(collapses.length, 0, 'no same-source strong collapse');
  assert.equal(survivors.length, rows.length, 'all nights survive the strong pre-pass');

  // (2) fuzzy pass: each night has a distinct title signature → distinct dedupKey,
  // and even a coincidental same-key cluster would be blocked by the ≥2-source guard.
  const groups = groupByKey(survivors);
  let merged = 0, collapsed = 0;
  for (const m of groups.values()) {
    if (!isMergeableGroup(m)) continue; // single-source → never mergeable
    const { losers } = mergeGroup(m); merged++; collapsed += losers.length;
  }
  assert.equal(merged, 0, 'no fuzzy merges among same-source occurrences');
  assert.equal(collapsed, 0, 'zero events marked duplicate — all 8 nights kept');

  // (3) the ≥2-source guard is what protects this: force the whole lineup into ONE
  // fuzzy group (same title) and it STILL must not merge while single-source.
  const sameTitle = rows.map((r) => ({ ...r, title: 'Conciertos de Viveros' }));
  assert.equal(distinctSourceCount(sameTitle), 1);
  assert.equal(isMergeableGroup(sameTitle), false, 'same-source cluster never merges');
});

test('T156 isStrongCollapsible: ≥2-source guard + untitled guard on the strong path', () => {
  // Cross-source (≥2 distinct sources) sharing a strong key → collapse (the legit dup).
  assert.equal(isStrongCollapsible([
    { id: 1, title: 'X', source: 'a' }, { id: 2, title: 'X', source: 'b' },
  ]), true, 'two distinct sources, same strong key → collapse');
  // Same-source with a REAL title → genuine re-fetch of one listing → collapse.
  assert.equal(isStrongCollapsible([
    { id: 1, title: 'Concierto Real', source: 'a' }, { id: 2, title: 'Concierto Real', source: 'a' },
  ]), true, 'same-source identifiable re-fetch → collapse');
  // Same-source UNTITLED (degenerate) → released, never collapse (would fuse distinct).
  assert.equal(isStrongCollapsible([
    { id: 1, title: '«»', source: 'a' }, { id: 2, title: '!!!', source: 'a' },
  ]), false, 'same-source untitled strong group is released, not collapsed');
  // A degenerate same-source url+date group passes ALL members through untouched.
  const page = 'https://x.com/agenda';
  const deg = strongMatchPrePass([
    { id: 1, title: '«»', city: 'Valencia', start_date: '2026-08-01', source: 'a', source_url: page, url: page, source_weight: 'good' },
    { id: 2, title: '!!!', city: 'Valencia', start_date: '2026-08-01', source: 'a', source_url: page, url: page, source_weight: 'good' },
  ]);
  assert.equal(deg.collapses.length, 0, 'untitled same url+date does not collapse');
  assert.deepEqual(deg.survivors.map((s) => s.id), [1, 2], 'both untitled rows survive (released)');
});

test('T035 strongMatchPrePass: NO strong keys → passthrough unchanged (idempotent)', () => {
  const rows = [
    { id: 1, title: 'Slava Komissarenko', city: 'Valencia', start_date: '2026-07-10', source: 'a' },
    { id: 2, title: 'Morgenstern', city: 'Valencia', start_date: '2026-07-11', source: 'b' },
  ];
  const { survivors, collapses } = strongMatchPrePass(rows);
  assert.equal(collapses.length, 0, 'nothing collapses without strong keys');
  assert.deepEqual(survivors.map((s) => s.id), [1, 2], 'all rows pass through, order kept');
  // second run over the survivors is a no-op (idempotent)
  const again = strongMatchPrePass(survivors);
  assert.equal(again.collapses.length, 0);
  assert.equal(again.survivors.length, 2);
});

test('T035 strongMatchPrePass: external_ref collapses only within the same source', () => {
  const rows = [
    { id: 1, title: 'A', city: 'Valencia', start_date: '2026-09-01', score: 20, source: 'feed', external_ref: 'EVT-7', source_url: 'u1', source_weight: 'good' },
    { id: 2, title: 'B', city: 'Valencia', start_date: '2026-09-01', score: 50, source: 'feed', external_ref: 'EVT-7', source_url: 'u2', source_weight: 'good' },
    { id: 3, title: 'C', city: 'Valencia', start_date: '2026-09-01', source: 'other', external_ref: 'EVT-7', source_url: 'u3' },
  ];
  const { survivors, collapses } = strongMatchPrePass(rows);
  // ids 1+2 (same source, same ext) collapse; id 3 (other source) does NOT
  assert.equal(collapses.length, 1);
  assert.equal(collapses[0].loser.id, 1, 'lower score loses');
  assert.equal(survivors.length, 2);
  assert.ok(survivors.some((s) => s.id === 3), 'cross-source same-ext stays separate');
});

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

// --- T185: merge gap-fills the survivor's end_date from a loser (the ¡BAILAR! case) ---
// A cac_agenda listing (survivor: higher score, no end_date) merges with the
// cac_exposiciones listing (loser: carries the multi-day span end_date) — the
// survivor must INHERIT the span so an exhibition keeps its calendar spanning-bar.
function bailarGroup() {
  return [
    {
      id: 25796, title: '¡BAILAR!', city: 'Valencia', start_date: '2025-10-03',
      end_date: null, score: 80, source: 'cac_agenda',
      source_url: 'https://caixaforum.org/agenda/bailar', source_weight: 'gold',
    },
    {
      id: 25797, title: '¡BAILAR!', city: 'Valencia', start_date: '2025-10-03',
      end_date: '2028-01-10', score: 50, source: 'cac_exposiciones',
      source_url: 'https://caixaforum.org/exposiciones/bailar', source_weight: 'gold',
    },
  ];
}

test('(T185 a) survivor with null end_date inherits a loser end_date', () => {
  const group = bailarGroup();
  const { survivor, losers } = mergeGroup(group);
  assert.equal(survivor.id, 25796, 'cac_agenda (higher score) survives');
  assert.equal(survivor.end_date, '2028-01-10', 'inherited the loser span');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].id, 25797);
});

test('(T185 b) survivor with a NON-null end_date keeps its OWN (no overwrite)', () => {
  const group = bailarGroup();
  group[0].end_date = '2026-02-01'; // survivor already has a span
  const { survivor } = mergeGroup(group);
  assert.equal(survivor.id, 25796);
  assert.equal(survivor.end_date, '2026-02-01', 'survivor keeps its own end_date');
});

test('(T185 c) no loser has an end_date → survivor stays null', () => {
  const group = bailarGroup();
  group[1].end_date = null; // strip the only loser span
  const { survivor } = mergeGroup(group);
  assert.equal(survivor.id, 25796);
  assert.equal(survivor.end_date ?? null, null, 'nothing to inherit → stays null');
});

test('(T185 d) furthest-future loser end_date wins when several losers have one', () => {
  const group = bailarGroup();
  group.push({
    id: 25798, title: '¡BAILAR!', city: 'Valencia', start_date: '2025-10-03',
    end_date: '2027-06-30', score: 40, source: 'cac_extra',
    source_url: 'https://caixaforum.org/x/bailar', source_weight: 'gold',
  });
  const { survivor } = mergeGroup(group);
  assert.equal(survivor.end_date, '2028-01-10', 'widest span (furthest future) chosen');
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

// ---------- T033 provenance: entitySourceRows (mirror of lib/pipeline/dedup.ts) ----------
// PURE: one entity_sources row per group member that carries a source_item_id —
// survivor as role='primary', losers as role='duplicate'; members without a
// source_item_id are skipped; de-dups on source_item_id. (DB-free; the FK-existence
// guard + idempotent UPSERT live in the orchestrator and are exercised live.)
function entitySourceRows(survivor, members, matchMethod) {
  const entityId = survivor.id;
  if (entityId == null) return [];
  const out = [];
  const seen = new Set();
  for (const m of members) {
    const sid = typeof m.source_item_id === 'number' ? m.source_item_id : null;
    if (sid == null || seen.has(sid)) continue;
    seen.add(sid);
    const isSurvivor = m.id != null && m.id === entityId;
    out.push({
      entity_type: 'event',
      entity_id: entityId,
      source_item_id: sid,
      source_key: typeof m.source === 'string' && m.source ? m.source : null,
      source_url: typeof m.source_url === 'string' && m.source_url ? m.source_url : null,
      role: isSurvivor ? 'primary' : 'duplicate',
      match_method: isSurvivor ? 'self' : matchMethod,
      match_score: typeof m.match_score === 'number' ? m.match_score : null,
    });
  }
  return out;
}

test('T033 entitySourceRows: one row per member-with-source_item_id, correct role', () => {
  const survivor = { id: 2, source: 'worldafisha', source_url: 'u2', source_item_id: 20 };
  const losers = [
    { id: 1, source: 'valenciarusa', source_url: 'u1', source_item_id: 10 },
    { id: 3, source: 'concerten', source_url: 'u3', source_item_id: 30 },
  ];
  const rows = entitySourceRows(survivor, [survivor, ...losers], 'fuzzy');
  assert.equal(rows.length, 3, 'three members → three rows');
  const prim = rows.filter((r) => r.role === 'primary');
  const dup = rows.filter((r) => r.role === 'duplicate');
  assert.equal(prim.length, 1, 'exactly one primary (the survivor)');
  assert.equal(dup.length, 2, 'two duplicates (the losers)');
  // survivor row: role primary, match_method 'self', points at survivor id
  assert.deepEqual(
    { entity_id: prim[0].entity_id, source_item_id: prim[0].source_item_id, method: prim[0].match_method },
    { entity_id: 2, source_item_id: 20, method: 'self' },
  );
  // all rows point at the SURVIVOR id, entity_type 'event'
  assert.ok(rows.every((r) => r.entity_id === 2 && r.entity_type === 'event'));
  // loser rows carry the passed matchMethod + their own source key/url
  assert.ok(dup.every((r) => r.match_method === 'fuzzy'));
  assert.deepEqual(dup.map((r) => r.source_item_id).sort((a, b) => a - b), [10, 30]);
  assert.deepEqual(dup.map((r) => r.source_key).sort(), ['concerten', 'valenciarusa']);
});

test('T033 entitySourceRows: members WITHOUT a source_item_id are skipped (seed path)', () => {
  const survivor = { id: 2, source: 'a', source_item_id: 20 };
  const members = [
    survivor,
    { id: 1, source: 'b' }, // seed event: no source_item_id → skipped
    { id: 3, source: 'c', source_item_id: null }, // explicit null → skipped
    { id: 4, source: 'd', source_item_id: 40 }, // has one → kept
  ];
  const rows = entitySourceRows(survivor, members, 'fuzzy');
  assert.equal(rows.length, 2, 'only the two members with a source_item_id emit rows');
  assert.deepEqual(rows.map((r) => r.source_item_id).sort((a, b) => a - b), [20, 40]);
});

test('T033 entitySourceRows: survivor without an id → no rows; de-dups on source_item_id', () => {
  // No survivor id (offline/seed survivor) → cannot key provenance → emit nothing.
  assert.deepEqual(entitySourceRows({ id: null, source_item_id: 5 }, [{ source_item_id: 5 }], 'strong'), []);
  // A duplicated source_item_id across members yields ONE row (matches the UNIQUE
  // constraint + ON CONFLICT idempotency).
  const survivor = { id: 9, source_item_id: 99 };
  const rows = entitySourceRows(survivor, [survivor, { id: 8, source_item_id: 99 }], 'strong');
  assert.equal(rows.length, 1, 'same source_item_id twice → one row (idempotent shape)');
  assert.equal(rows[0].role, 'primary');
});

test('T033 entitySourceRows: a survivor that is also its own only member → one primary row', () => {
  // Strong-collapse survivor whose only contributor is itself (degenerate but legal).
  const s = { id: 7, source: 'x', source_url: 'ux', source_item_id: 70 };
  const rows = entitySourceRows(s, [s], 'strong');
  assert.deepEqual(rows.map((r) => ({ role: r.role, sid: r.source_item_id, m: r.match_method })), [
    { role: 'primary', sid: 70, m: 'self' },
  ]);
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

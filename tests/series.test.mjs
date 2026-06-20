import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Pure-logic mirror of the identity helpers in lib/pipeline/series.ts (sub-area D).
const sha1short = (b) => crypto.createHash('sha1').update(b, 'utf-8').digest('hex').slice(0, 16);
function norm(value) {
  if (value == null) return '';
  let t = String(value).toLowerCase().trim();
  t = t.replace(/[\s ]+/g, ' ');
  t = t.replace(/[^\p{L}\p{N}\s]/gu, '');
  return t;
}
const seriesHash = (s) => sha1short(`${norm(s.title)}|${norm(s.venue_name)}|${s.source}`);
const occurrenceHash = (id, date, time) => sha1short(`${id}|${date}|${time ?? ''}`);

test('seriesHash: deterministic + identity by (title, venue, source)', () => {
  const a = { title: 'Dune: Part Two', venue_name: 'Hemisfèric', source: 'api:hemisferic' };
  assert.equal(seriesHash(a), seriesHash({ ...a }), 'same inputs -> same hash');
  // punctuation/case are normalized away by norm()
  assert.equal(
    seriesHash(a),
    seriesHash({ title: 'dune  part two!', venue_name: 'hemisfèric', source: 'api:hemisferic' }),
  );
  // different film -> different series
  assert.notEqual(seriesHash(a), seriesHash({ ...a, title: 'Oppenheimer' }));
  // same film, different source -> different series (cross-source dedup deferred)
  assert.notEqual(seriesHash(a), seriesHash({ ...a, source: 'web:cac' }));
});

test('occurrenceHash: stable per (series, date, time); null time === empty', () => {
  assert.equal(occurrenceHash(5, '2026-07-01', '18:00'), occurrenceHash(5, '2026-07-01', '18:00'));
  assert.notEqual(occurrenceHash(5, '2026-07-01', '18:00'), occurrenceHash(5, '2026-07-01', '20:30'));
  assert.notEqual(occurrenceHash(5, '2026-07-01', '18:00'), occurrenceHash(5, '2026-07-02', '18:00'));
  assert.equal(occurrenceHash(5, '2026-07-01', null), occurrenceHash(5, '2026-07-01', undefined));
});

// ---------------------------------------------------------------------------
// T044: pure-logic mirror of the Hemisfèric migration grouping
// (scripts/migrate-hemisferic-series.mjs groupHemisfericEvents). Proves the 104
// dated `events` collapse to 11 series + 104 occurrences, the grouping is idempotent
// (same input → identical hashes), and the occurrence count is preserved.
// ---------------------------------------------------------------------------

// Mirror of groupHemisfericEvents: bucket by seriesHash(title,venue,source), one
// occurrence per member row, series score = max of members, span = [min,max] date.
function groupHemisfericEvents(rows) {
  const byHash = new Map();
  for (const r of rows) {
    const key = seriesHash({ title: r.title, venue_name: r.venue_name, source: r.source });
    let g = byHash.get(key);
    if (!g) {
      g = { key, series: { title: r.title, venue_name: r.venue_name, source: r.source }, occurrences: [], days: [], score: null };
      byHash.set(key, g);
    }
    const sc = r.score == null ? null : Number(r.score);
    if (sc != null && (g.score == null || sc > g.score)) g.score = sc;
    if (r.start_date) g.days.push(r.start_date);
    g.occurrences.push({ occurrence_date: r.start_date || '', start_time: r.start_time ?? null });
  }
  const out = [];
  for (const g of byHash.values()) {
    const dated = g.days.filter(Boolean).sort();
    g.series.start_date = dated[0] ?? null;
    g.series.end_date = dated[dated.length - 1] ?? null;
    g.series.score = g.score;
    g.occurrences = g.occurrences.filter((o) => o.occurrence_date);
    out.push(g);
  }
  return out;
}

const VENUE = "L'Hemisfèric";
const SOURCE = 'api:hemisferic';

// The real seed distribution: 11 shows, counts summing to 104 (verified on the live DB).
const SHOWS = [
  ['3, 2, 1... ¡Despegamos!', 10, 92],
  ['Animal Kingdom', 14, 98],
  ['Auroras + Waiting far away', 13, 92],
  ['Caminando entre dinosaurios 3D', 11, 92],
  ['Dinosaurios: una historia de supervivencia', 11, 92],
  ['Eclipse + The Incredible Sun', 14, 92],
  ['El arrecife encantado de Kaluoka`hina 3D', 1, 98],
  ['Las Nocturnas', 4, 92],
  ['Oceans: Our Blue Planet', 14, 92],
  ['Postales de otros mundos', 9, 92],
  ['Recombination', 3, 88],
];

function buildRows() {
  const rows = [];
  let id = 200;
  for (const [title, count, score] of SHOWS) {
    for (let i = 0; i < count; i++) {
      const day = 20 + (i % 10);
      rows.push({
        id: id++,
        title,
        venue_name: VENUE,
        source: SOURCE,
        start_date: `2026-06-${String(day).padStart(2, '0')}`,
        start_time: ['12:00', '16:00', '17:00', '19:00'][i % 4],
        score,
      });
    }
  }
  return rows;
}

test('grouping: 104 rows across 11 titles → 11 series + 104 occurrences', () => {
  const rows = buildRows();
  assert.equal(rows.length, 104, 'fixture is 104 rows');
  assert.equal(new Set(rows.map((r) => r.title)).size, 11, 'fixture spans 11 titles');

  const groups = groupHemisfericEvents(rows);
  assert.equal(groups.length, 11, '11 series');
  const totalOcc = groups.reduce((n, g) => n + g.occurrences.length, 0);
  assert.equal(totalOcc, 104, 'occurrence count preserved (none lost or invented)');
});

test('grouping: series score = max of members; start_date <= end_date', () => {
  const groups = groupHemisfericEvents(buildRows());
  assert.equal(groups.find((g) => g.series.title === 'Animal Kingdom').series.score, 98);
  assert.equal(groups.find((g) => g.series.title === 'Recombination').series.score, 88);
  for (const g of groups) assert.ok(g.series.start_date <= g.series.end_date);
});

test('grouping: idempotent — re-grouping yields identical series + occurrence hashes', () => {
  const rows = buildRows();
  const fingerprint = (groups) =>
    groups
      .map((g, idx) => {
        const occ = g.occurrences
          .map((o) => occurrenceHash(idx + 1, o.occurrence_date, o.start_time))
          .sort();
        return `${g.key}::${occ.join(',')}`;
      })
      .sort();
  assert.deepEqual(fingerprint(groupHemisfericEvents(rows)), fingerprint(groupHemisfericEvents(rows)));
});

test('grouping: same show across two days stays ONE series (date does not split it)', () => {
  const rows = [
    { id: 1, title: 'Animal Kingdom', venue_name: VENUE, source: SOURCE, start_date: '2026-06-20', start_time: '12:00', score: 98 },
    { id: 2, title: 'Animal Kingdom', venue_name: VENUE, source: SOURCE, start_date: '2026-06-21', start_time: '17:00', score: 98 },
  ];
  const groups = groupHemisfericEvents(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].occurrences.length, 2);
});

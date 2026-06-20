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

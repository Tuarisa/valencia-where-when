import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of buildHemisfericSeries (lib/pipeline/normalizers/hemisferic.ts).
// Verifies the model change (research D4): N raw rows (film × day) -> one series per
// film + one occurrence per (day × session). DB-free, mirrors the TS.
const VENUE = "L'Hemisfèric";
function parseRaw(item) {
  try { const r = JSON.parse(item.raw_json || '{}'); return r && typeof r === 'object' ? r : {}; }
  catch { return {}; }
}
function buildHemisfericSeries(rows) {
  const byShow = new Map();
  for (const item of rows) {
    const raw = parseRaw(item);
    const showName = raw.show_name || item.title || 'Hemisfèric';
    const day = raw.schedule_date || (item.published_at || '').slice(0, 10) || null;
    const sessions = Array.isArray(raw.session_times) ? raw.session_times : [];
    let group = byShow.get(showName);
    if (!group) {
      group = { series: { title: showName, venue_name: VENUE, source: 'api:hemisferic', recurrence_kind: 'sessions', image_url: raw.poster_url || null }, occurrences: [], days: [] };
      byShow.set(showName, group);
    }
    if (!group.series.image_url && raw.poster_url) group.series.image_url = raw.poster_url;
    if (day) group.days.push(day);
    const sessionTimes = sessions.length ? sessions : [null];
    for (const t of sessionTimes) {
      group.occurrences.push({ occurrence_date: day || '', start_time: t, source_item_id: item.id });
    }
  }
  const out = [];
  for (const { series, occurrences, days } of byShow.values()) {
    const dated = days.filter(Boolean).sort();
    series.start_date = dated[0] ?? null;
    series.end_date = dated[dated.length - 1] ?? null;
    out.push({ series, occurrences: occurrences.filter((o) => o.occurrence_date) });
  }
  return out;
}

const raw = (id, show, date, sessions) => ({
  id, title: show, url: 'https://hemisferic.org', raw_text: show,
  raw_json: JSON.stringify({ show_name: show, schedule_date: date, session_times: sessions, poster_url: `https://img/${show}.jpg` }),
});

test('buildHemisfericSeries: films collapse to series, sessions become occurrences', () => {
  const rows = [
    raw(1, 'Dune', '2026-07-01', ['18:00', '20:30']),
    raw(2, 'Dune', '2026-07-02', ['18:00', '20:30']),
    raw(3, 'Oceans', '2026-07-01', ['12:00']),
  ];
  const out = buildHemisfericSeries(rows);
  assert.equal(out.length, 2, 'two films -> two series');
  const dune = out.find((s) => s.series.title === 'Dune');
  assert.equal(dune.occurrences.length, 4, 'Dune: 2 days x 2 sessions = 4 occurrences');
  assert.equal(dune.series.start_date, '2026-07-01');
  assert.equal(dune.series.end_date, '2026-07-02');
  assert.equal(dune.series.venue_name, VENUE);
  const oceans = out.find((s) => s.series.title === 'Oceans');
  assert.equal(oceans.occurrences.length, 1);
});

test('buildHemisfericSeries: no sessions -> one null-time occurrence; no date dropped', () => {
  const noSession = buildHemisfericSeries([raw(1, 'Film', '2026-07-05', [])]);
  assert.equal(noSession[0].occurrences.length, 1);
  assert.equal(noSession[0].occurrences[0].start_time, null);
  const noDate = buildHemisfericSeries([raw(1, 'Film', null, ['18:00'])]);
  assert.equal(noDate[0].occurrences.length, 0, 'occurrence with no date is dropped');
});

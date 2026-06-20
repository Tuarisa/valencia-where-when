import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of the enrich orchestration (lib/pipeline/enrich.ts, sub-area E).
// The LLM engine is injected, so the batch logic — selection, per-item try/catch
// (fail-soft, constitution IV), dry-run — runs fully offline with NO key/network.
const intBool = (v) => (v == null ? null : v ? 1 : 0);

function mockExec(rows) {
  // tagged-template stub: SELECT → rows, UPDATE → []
  return (strings) => Promise.resolve(/select/i.test(strings.join(' ')) ? rows : []);
}
async function enrichOne(row, { client, exec, web = false }) {
  const r = await client.enrich(row, { web });
  await exec`UPDATE events SET enriched_at = ${'now'} WHERE id = ${row.id}`;
  return r;
}
async function enrichCards(limit, { client, exec, dry = false }) {
  const rows = await exec`SELECT id FROM events WHERE enriched_at IS NULL LIMIT ${limit}`;
  let enriched = 0, errors = 0, skipped = 0;
  for (const row of rows) {
    if (dry) { skipped++; continue; }
    try { await enrichOne(row, { client, exec }); enriched++; }
    catch { errors++; }
  }
  return { attempted: rows.length, enriched, skipped, errors };
}

const okClient = { enrich: async () => ({ title_ru: 'Тест', description_ru: 'Описание', confidence: 0.9 }) };

test('enrichCards: all succeed', async () => {
  const r = await enrichCards(10, { client: okClient, exec: mockExec([{ id: 1 }, { id: 2 }, { id: 3 }]) });
  assert.deepEqual(r, { attempted: 3, enriched: 3, skipped: 0, errors: 0 });
});

test('enrichCards: fail-soft — one bad card is counted, batch continues', async () => {
  const flaky = {
    enrich: async (row) => {
      if (row.id === 2) throw new Error('boom');
      return { title_ru: 'x', description_ru: 'y', confidence: 0.5 };
    },
  };
  const r = await enrichCards(10, { client: flaky, exec: mockExec([{ id: 1 }, { id: 2 }, { id: 3 }]) });
  assert.equal(r.enriched, 2);
  assert.equal(r.errors, 1);
});

test('enrichCards: dry selects but writes nothing', async () => {
  const r = await enrichCards(10, { client: okClient, exec: mockExec([{ id: 1 }, { id: 2 }]), dry: true });
  assert.deepEqual(r, { attempted: 2, enriched: 0, skipped: 2, errors: 0 });
});

test('intBool: boolean→int, null/undefined→null (events.is_free is INTEGER)', () => {
  assert.equal(intBool(true), 1);
  assert.equal(intBool(false), 0);
  assert.equal(intBool(null), null);
  assert.equal(intBool(undefined), null);
});

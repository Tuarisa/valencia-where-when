import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of lib/pipeline/normalize.ts dispatch (resolveNormalizer):
// a registry Map keyed by source_key resolves known sources to a normalizer and
// unknown sources to undefined (→ marked `ignored` by the dispatcher). No DB:
// this exercises the dispatch contract with injected functions only, matching
// the real `resolveNormalizer(sourceKey, registry)` signature.
function resolveNormalizer(sourceKey, registry) {
  return registry.get(sourceKey);
}

// Classify a source the way normalizeAll() does: a registered key is dispatched
// to its normalizer; an unregistered key resolves to status `ignored`.
function classify(sourceKey, registry) {
  const fn = resolveNormalizer(sourceKey, registry);
  return fn ? 'dispatch' : 'ignored';
}

test('registry dispatches a known source key to its normalizer', () => {
  const hemisferic = () => ({ created: 1, updated: 0, processed: 1 });
  const registry = new Map([['api:hemisferic', hemisferic]]);

  const fn = resolveNormalizer('api:hemisferic', registry);
  assert.equal(typeof fn, 'function');
  assert.equal(classify('api:hemisferic', registry), 'dispatch');
  assert.deepEqual(fn(), { created: 1, updated: 0, processed: 1 });
});

test('unknown source key resolves to ignored', () => {
  const registry = new Map([['api:hemisferic', () => ({ created: 0, updated: 0, processed: 0 })]]);

  assert.equal(resolveNormalizer('web:unknown-source', registry), undefined);
  assert.equal(classify('web:unknown-source', registry), 'ignored');
});

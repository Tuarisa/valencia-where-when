import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-logic mirror of resolveParserKey (lib/pipeline/ingest.ts, sub-area A).
const KEYS = new Set(['api:hemisferic', 'telegram', 'web', 'ticketing', 'api']);
function resolveParserKey(source) {
  if (source.key && KEYS.has(source.key)) return source.key;
  if (source.type === 'telegram' || (source.url || '').includes('t.me/s/')) return 'telegram';
  if (source.type && KEYS.has(source.type)) return source.type;
  return 'web';
}

test('resolveParserKey: bespoke key wins', () => {
  assert.equal(resolveParserKey({ key: 'api:hemisferic', type: 'api' }), 'api:hemisferic');
});

test('resolveParserKey: telegram by type or t.me/s/ url', () => {
  assert.equal(resolveParserKey({ key: 'tg:x', type: 'telegram', url: 'https://t.me/s/x' }), 'telegram');
  // url match takes precedence over a non-telegram type
  assert.equal(resolveParserKey({ key: 'web:y', type: 'web', url: 'https://t.me/s/y' }), 'telegram');
});

test('resolveParserKey: by type, else web fallback', () => {
  assert.equal(resolveParserKey({ key: 'web:cac', type: 'web', url: 'https://cac.es' }), 'web');
  assert.equal(resolveParserKey({ key: 'tm:1', type: 'ticketing', url: 'https://ticketmaster.es' }), 'ticketing');
  assert.equal(resolveParserKey({ key: 'mystery', type: 'rss', url: 'https://x.com' }), 'web');
});

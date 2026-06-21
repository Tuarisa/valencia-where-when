import test from 'node:test';
import assert from 'node:assert/strict';

// Tests for lib/pipeline/util.ts `sanitizeText` (T147). Imports the REAL helper from
// the TS module (run via `node --import tsx --test`). The bug: tg:rutatuta_vlc posts
// reached `upsertSourceItem` carrying a LONE high surrogate (a `.slice(0, 200)` cut
// landing mid-emoji), which the @neondatabase/serverless HTTP driver rejects with
// "could not parse the HTTP request body: unexpected end of hex escape". The sanitizer
// strips that + NUL/control bytes + noncharacters while leaving clean text untouched.
import { sanitizeText } from '../lib/pipeline/util.ts';

// Bytes built programmatically so this test file carries no literal control bytes.
const NUL = String.fromCharCode(0x00);
const VTAB = String.fromCharCode(0x0b);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x9b);
const NONCHAR = String.fromCharCode(0xffff);
const LONE_HIGH = String.fromCharCode(0xd83d); // chopped high half of an emoji surrogate
const LONE_LOW = String.fromCharCode(0xde00); // chopped low half

test('sanitizeText: strips a lone high surrogate (the rutatuta T147 case)', () => {
  // Mirrors the real field: "…2,5 часа " + a chopped emoji at the slice boundary.
  const dirty = '🕔 2,5 часа ' + LONE_HIGH;
  const clean = sanitizeText(dirty);
  assert.equal(clean, '🕔 2,5 часа ');
  // No lone surrogate remains.
  assert.match(clean, /^[^\uD800-\uDFFF]*(?:[\uD800-\uDBFF][\uDC00-\uDFFF][^\uD800-\uDFFF]*)*$/);
});

test('sanitizeText: strips a lone low surrogate', () => {
  assert.equal(sanitizeText('hola ' + LONE_LOW + ' mundo'), 'hola  mundo');
});

test('sanitizeText: strips NUL and disallowed control chars', () => {
  assert.equal(sanitizeText('a' + NUL + 'b' + VTAB + 'c' + DEL + 'd' + C1 + 'e'), 'abcde');
});

test('sanitizeText: strips Unicode noncharacters', () => {
  assert.equal(sanitizeText('x' + NONCHAR + 'y'), 'xy');
});

test('sanitizeText: preserves TAB / LF / CR (whitespace kept)', () => {
  const ws = 'line1\n\tline2\r\nline3';
  assert.equal(sanitizeText(ws), ws);
});

test('sanitizeText: clean RU text, links and intact emoji round-trip unchanged', () => {
  const clean = 'Привет, Валенсия! 🎉 Las Fallas 2026 — https://t.me/rutatuta_vlc/123 €25 ñ ü';
  assert.equal(sanitizeText(clean), clean);
});

test('sanitizeText: an intact surrogate-pair emoji at the END is preserved', () => {
  const clean = 'кафе у моря 🏖️';
  assert.equal(sanitizeText(clean), clean);
});

test('sanitizeText: passes through null / undefined unchanged', () => {
  assert.equal(sanitizeText(null), null);
  assert.equal(sanitizeText(undefined), undefined);
});

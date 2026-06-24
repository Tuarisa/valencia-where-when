import test from "node:test";
import assert from "node:assert/strict";

// T189 — display-layer tag hygiene. Imports the REAL pure helpers from lib/tags.ts
// (run via `node --import tsx --test`) so the assertions exercise the shipped logic.
import { cleanTags, isNoiseTag } from "../lib/tags.ts";
// T187 — image-url gate (dead Telegram CDN → null → placeholder).
import { usableImageUrl } from "../lib/format.ts";

test("cleanTags drops system / internal tags", () => {
  // Exact system labels (both slug and spaced forms).
  assert.equal(isNoiseTag("has-image"), true);
  assert.equal(isNoiseTag("has image"), true);
  assert.equal(isNoiseTag("mapped"), true);
  assert.equal(isNoiseTag("place"), true);
  // Namespaced / source-key prefixes (slug + ":" forms).
  assert.equal(isNoiseTag("tg-logunespa"), true);
  assert.equal(isNoiseTag("tg:logunespa"), true);
  assert.equal(isNoiseTag("city:valencia"), true);
  assert.equal(isNoiseTag("area:camp-de-morvedre"), true);
  assert.equal(isNoiseTag("from:logunespa"), true);
  assert.equal(isNoiseTag("source:web"), true);
  assert.equal(isNoiseTag("web:fever"), true);
  assert.equal(isNoiseTag("api:hemisferic"), true);
});

test("cleanTags drops garbage / price-menu dumps", () => {
  // Pure numeric / punctuation.
  assert.equal(isNoiseTag("99 5"), true);
  assert.equal(isNoiseTag("4-5013-10-13-12-9-6-50-4-50"), true);
  // Long price dumps as they actually appear in the DB (slug form, 45+ chars → len rule).
  assert.equal(isNoiseTag("angus-premium-15-50-secreto-premium-12-90-gyoza-mandu-frita-7"), true);
  assert.equal(isNoiseTag("4-95-6-5-50-4-5-50-fried-chicken-12-95-13-95"), true);
  assert.equal(isNoiseTag("tris-di-focacce-16-99-11-99-3-50-paccheri-di-gianni-17-99"), true);
});

test("cleanTags keeps real human tags", () => {
  assert.equal(isNoiseTag("bbq"), false);
  assert.equal(isNoiseTag("food"), false);
  assert.equal(isNoiseTag("acai bowls"), false);
  assert.equal(isNoiseTag("acai-bowls"), false);
  assert.equal(isNoiseTag("family"), false);
  assert.equal(isNoiseTag("basilica"), false);
  assert.equal(isNoiseTag("pool"), false);
});

test("cleanTags on a realistic mixed list keeps only the human tags", () => {
  const raw = [
    "4-5013-10-13-12-9-6-50-4-50",
    "city:valencia",
    "family",
    "has-image",
    "mapped",
    "place",
    "tg-logunespa",
    "bbq",
  ];
  assert.deepEqual(cleanTags(raw), ["family", "bbq"]);
});

test("cleanTags handles non-array / empty input", () => {
  assert.deepEqual(cleanTags([]), []);
  assert.deepEqual(cleanTags(/** @type {any} */ (null)), []);
  assert.deepEqual(cleanTags(["", "   "]), []);
});

test("usableImageUrl returns null for dead Telegram CDN hosts", () => {
  assert.equal(usableImageUrl("https://cdn4.telesco.pe/file/abc.jpg"), null);
  assert.equal(usableImageUrl("https://telesco.pe/file/x.jpg"), null);
  assert.equal(usableImageUrl("https://cdn1.telesco.pe/file/y.png"), null);
});

test("usableImageUrl returns null for empty / non-absolute / non-http urls", () => {
  assert.equal(usableImageUrl(""), null);
  assert.equal(usableImageUrl(null), null);
  assert.equal(usableImageUrl(undefined), null);
  assert.equal(usableImageUrl("/local/relative.jpg"), null);
  assert.equal(usableImageUrl("data:image/png;base64,xxx"), null);
});

test("usableImageUrl passes through a real loadable host", () => {
  const ok = "https://bombasgens.com/img/poster.jpg";
  assert.equal(usableImageUrl(ok), ok);
  assert.equal(usableImageUrl("https://www.visitvalencia.com/x.png"), "https://www.visitvalencia.com/x.png");
});

import test from "node:test";
import assert from "node:assert/strict";
import { needsExtraCa } from "../lib/pipeline/util.ts";

// T148 (hardened): cac.es serves an INCOMPLETE TLS certificate chain (omits a valid
// intermediate CA), which Node's `fetch` (undici) rejects with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE. The ingest fetch path routes such hosts through a
// built-in https GET that ADDS the bundled intermediate to the trust store — TLS
// verification stays FULLY ON (rejectUnauthorized:true), no insecure bypass. This is
// gated to an EXPLICIT, SMALL allowlist. `needsExtraCa` is the pure selector — this
// test pins exactly which hosts get the bundled-CA path (no network).

test("needsExtraCa: allowlisted cac.es host is selected", () => {
  assert.equal(needsExtraCa("https://cac.es/agenda/"), true);
  assert.equal(needsExtraCa("https://cac.es/exposiciones/"), true);
  assert.equal(needsExtraCa("https://cac.es/actividades/"), true);
  assert.equal(needsExtraCa("https://cac.es/museu-de-les-ciencies/"), true);
});

test("needsExtraCa: subdomains of an allowlisted host are covered", () => {
  assert.equal(needsExtraCa("https://www.cac.es/x"), true);
  assert.equal(needsExtraCa("https://servicios.cac.es/apiback"), true);
  assert.equal(needsExtraCa("https://exposiciones.cac.es/media/x.jpg"), true);
});

test("needsExtraCa: normal hosts are NOT given the extra-CA path", () => {
  assert.equal(needsExtraCa("https://example.com"), false);
  assert.equal(needsExtraCa("https://visitvalencia.com/agenda"), false);
  assert.equal(needsExtraCa("https://t.me/s/logunespa"), false);
});

test("needsExtraCa: a look-alike host is NOT matched (suffix, not substring)", () => {
  // evilcac.es ends with "cac.es" as a substring but is a different registrable host;
  // the match must be exact or a dot-prefixed subdomain (".cac.es"), never a bare suffix.
  assert.equal(needsExtraCa("https://evilcac.es"), false);
  assert.equal(needsExtraCa("https://notcac.es/path"), false);
});

test("needsExtraCa: only https qualifies; http and garbage do not", () => {
  // The fix is a TLS-chain completion, so plain http (no TLS) never needs it.
  assert.equal(needsExtraCa("http://cac.es/agenda/"), false);
  assert.equal(needsExtraCa("not a url"), false);
  assert.equal(needsExtraCa(""), false);
});

test("needsExtraCa: host match is case-insensitive", () => {
  assert.equal(needsExtraCa("https://CAC.ES/Agenda/"), true);
  assert.equal(needsExtraCa("https://Servicios.Cac.Es/x"), true);
});

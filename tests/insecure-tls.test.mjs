import test from "node:test";
import assert from "node:assert/strict";
import { needsInsecureTls } from "../lib/pipeline/util.ts";

// T148: cac.es serves an incomplete TLS certificate chain (missing intermediate CA),
// which Node's `fetch` (undici) rejects with UNABLE_TO_VERIFY_LEAF_SIGNATURE. The
// ingest fetch path falls back to a built-in https GET with rejectUnauthorized:false
// for an EXPLICIT, SMALL allowlist of such hosts only. `needsInsecureTls` is the pure
// selector — this test pins exactly which hosts get the workaround (no network).

test("needsInsecureTls: allowlisted cac.es host is selected", () => {
  assert.equal(needsInsecureTls("https://cac.es/agenda/"), true);
  assert.equal(needsInsecureTls("https://cac.es/exposiciones/"), true);
  assert.equal(needsInsecureTls("https://cac.es/actividades/"), true);
  assert.equal(needsInsecureTls("https://cac.es/museu-de-les-ciencies/"), true);
});

test("needsInsecureTls: subdomains of an allowlisted host are covered", () => {
  assert.equal(needsInsecureTls("https://www.cac.es/x"), true);
  assert.equal(needsInsecureTls("https://servicios.cac.es/apiback"), true);
  assert.equal(needsInsecureTls("https://exposiciones.cac.es/media/x.jpg"), true);
});

test("needsInsecureTls: normal hosts are NOT weakened", () => {
  assert.equal(needsInsecureTls("https://example.com"), false);
  assert.equal(needsInsecureTls("https://visitvalencia.com/agenda"), false);
  assert.equal(needsInsecureTls("https://t.me/s/logunespa"), false);
});

test("needsInsecureTls: a look-alike host is NOT matched (suffix, not substring)", () => {
  // evilcac.es ends with "cac.es" as a substring but is a different registrable host;
  // the match must be exact or a dot-prefixed subdomain (".cac.es"), never a bare suffix.
  assert.equal(needsInsecureTls("https://evilcac.es"), false);
  assert.equal(needsInsecureTls("https://notcac.es/path"), false);
});

test("needsInsecureTls: only https qualifies; http and garbage do not", () => {
  // The workaround is a TLS-chain fix, so plain http (no TLS) never needs it.
  assert.equal(needsInsecureTls("http://cac.es/agenda/"), false);
  assert.equal(needsInsecureTls("not a url"), false);
  assert.equal(needsInsecureTls(""), false);
});

test("needsInsecureTls: host match is case-insensitive", () => {
  assert.equal(needsInsecureTls("https://CAC.ES/Agenda/"), true);
  assert.equal(needsInsecureTls("https://Servicios.Cac.Es/x"), true);
});

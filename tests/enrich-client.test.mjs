import test from "node:test";
import assert from "node:assert/strict";

// Pure-logic mirror of lib/pipeline/enrich-client.ts (the `claude -p` EnrichClient,
// T051/T053 engine). Mirrors the link-selection, prompt-shaping and JSON-extraction
// helpers so they are verified without spawning the CLI (the real client injects `run`).

function enrichSourceLinks(row) {
  const raw = [];
  if (row.source_url) raw.push(String(row.source_url));
  if (row.links_json) {
    try {
      const arr = JSON.parse(row.links_json);
      if (Array.isArray(arr)) for (const l of arr) if (l && l.url) raw.push(String(l.url));
    } catch {
      /* ignore */
    }
  }
  const seen = new Set();
  const out = [];
  for (const u of raw) {
    if (!/^https?:\/\//.test(u)) continue;
    if (/instagram\.com|facebook\.com/.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= 4) break;
  }
  return out;
}

function buildEnrichPrompt(row, web) {
  const links = web ? enrichSourceLinks(row) : [];
  return [
    "Ты обогащаешь карточку события в Валенсии (Испания) для русскоязычной семейной афиши.",
    web && links.length
      ? `Источники события: ${links.join(" , ")}. ОТКРОЙ их (WebFetch) и прочитай содержимое, чтобы ЗАЗЕМЛИТЬ факты`
      : "Опирайся ТОЛЬКО на текст карточки ниже; НЕ выдумывай факты — неизвестное оставляй null.",
    "КАРТОЧКА:",
    `title: ${row.title ?? ""}`,
  ].filter(Boolean).join("\n");
}

function extractJsonObject(stdout) {
  const m = stdout.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON object");
  return JSON.parse(m[0]);
}

test("enrichSourceLinks: source_url + links_json, drops social, de-dups, caps at 4", () => {
  const row = {
    source_url: "https://valenciarusa.es/event/1",
    links_json: JSON.stringify([
      { url: "https://valenciarusa.es/event/1" }, // dup of source_url
      { url: "https://bombasgens.com/titanic" },
      { url: "https://instagram.com/page" }, // social → dropped
      { url: "https://visitvalencia.com/a" },
      { url: "https://example.com/b" },
      { url: "https://example.com/c" }, // 5th distinct → over the cap
      { url: "ftp://nope" }, // non-http → dropped
    ]),
  };
  const links = enrichSourceLinks(row);
  assert.ok(!links.some((u) => u.includes("instagram")), "drops instagram");
  assert.ok(!links.some((u) => u.startsWith("ftp")), "drops non-http");
  assert.equal(new Set(links).size, links.length, "de-duped");
  assert.ok(links.length <= 4, "capped at 4");
  assert.equal(links[0], "https://valenciarusa.es/event/1");
});

test("enrichSourceLinks: tolerates missing/garbage links_json", () => {
  assert.deepEqual(enrichSourceLinks({}), []);
  assert.deepEqual(enrichSourceLinks({ links_json: "not json" }), []);
  assert.deepEqual(enrichSourceLinks({ source_url: "https://x.test" }), ["https://x.test"]);
});

test("buildEnrichPrompt: web=true adds WebFetch grounding instruction; web=false pins to text", () => {
  const row = { title: "Концерт", source_url: "https://x.test/a" };
  const withWeb = buildEnrichPrompt(row, true);
  const noWeb = buildEnrichPrompt(row, false);
  assert.ok(withWeb.includes("WebFetch"), "web prompt instructs WebFetch");
  assert.ok(withWeb.includes("https://x.test/a"), "web prompt lists the source link");
  assert.ok(!noWeb.includes("WebFetch"), "non-web prompt does not WebFetch");
  assert.ok(noWeb.includes("НЕ выдумывай"), "non-web prompt forbids invention");
});

test("buildEnrichPrompt: web=true with no links falls back to the text-only instruction", () => {
  const p = buildEnrichPrompt({ title: "X" }, true);
  assert.ok(!p.includes("WebFetch"), "no links → no WebFetch instruction");
});

test("extractJsonObject: pulls the object out of chatty stdout", () => {
  const out = 'Here is the result:\n```json\n{"title_ru":"Концерт","confidence":0.8}\n```\nDone.';
  const obj = extractJsonObject(out);
  assert.equal(obj.title_ru, "Концерт");
  assert.equal(obj.confidence, 0.8);
});

test("extractJsonObject: throws when there is no object", () => {
  assert.throws(() => extractJsonObject("no json here"), /no JSON object/);
});

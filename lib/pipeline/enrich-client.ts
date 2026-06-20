import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EnrichClient, EnrichInput, EnrichmentResult } from "./enrich";

// Concrete DEFAULT enrichment engine: `claude -p` (Claude subscription / OAuth, NO API
// key — constitution IV). Shells out exactly like scripts/crawl-telegram.mjs already
// does for the telegram crawl, so it inherits the user's logged-in CLI session and
// needs no ANTHROPIC_API_KEY. The model is asked to return ONLY the canonical
// enrichment_json object; we extract it defensively (enrich.ts then runs
// normalizeEnrichment + ground-or-flag on it, so this client may return loosely).
//
// T053 — web augmentation: with { web: true } the prompt instructs claude to WebFetch
// the card's source links and READ them to GROUND facts (address / hours / price) and
// cite each one in citations[]. OFF by default. supportsWeb advertises the capability.
//
// Engine-agnostic by construction: enrich.ts injects this client; tests inject a mock
// (or override `run`). Nothing in enrich.ts imports this file, and this file imports
// only TYPES from enrich.ts (erased at compile time), so the pipeline stays key-free,
// mockable, and free of any runtime coupling to the DB module.

const execFileP = promisify(execFile);

export interface ClaudeEnrichOptions {
  timeoutMs?: number; // per-call cap; WebFetch of source links adds latency
  maxBuffer?: number;
  bin?: string; // override the `claude` binary (tests / non-standard installs)
  model?: string; // CLI model: alias `opus`/`sonnet`/`haiku` or full id. When set, PINS
  // BOTH paths (passed as `--model`). When unset, per-path floors apply: haiku
  // (translation) / sonnet (grounded) — ENRICH_MODEL / ENRICH_MODEL_WEB override per path.
  // Override the actual exec (tests): receives the prompt, returns claude's stdout.
  run?: (prompt: string) => Promise<string>;
}

// The shape we ask the model for — a readable mirror of EnrichmentResult / ENRICHMENT_KEYS.
const SCHEMA_HINT =
  '{"title_ru":str,"description_ru":str,"category":str|null,"start_date":"YYYY-MM-DD"|null,' +
  '"end_date":"YYYY-MM-DD"|null,"start_time":"HH:MM"|null,"end_time":"HH:MM"|null,' +
  '"venue_name":str|null,"address":str|null,"district":str|null,"price":str|null,' +
  '"is_free":bool|null,"maps_url":str|null,"image_url":str|null,' +
  '"links":[{"label":str,"url":str}],"citations":[{"url":str,"supports":str}],' +
  '"confidence":0..1,"notes":str|null}';

// PURE: the source links worth grounding against — source_url plus any {url} in
// links_json. Drops social noise (low grounding value), de-dups, caps at 4.
export function enrichSourceLinks(row: EnrichInput): string[] {
  const raw: string[] = [];
  if (row.source_url) raw.push(String(row.source_url));
  if (row.links_json) {
    try {
      const arr = JSON.parse(row.links_json);
      if (Array.isArray(arr)) for (const l of arr) if (l && l.url) raw.push(String(l.url));
    } catch {
      /* malformed links_json → ignore, fall back to text */
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
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

// PURE: build the `claude -p` prompt for one card. With web=true and real links it adds
// the WebFetch + ground-or-cite instruction; otherwise it pins the model to the card text.
export function buildEnrichPrompt(row: EnrichInput, web: boolean): string {
  const links = web ? enrichSourceLinks(row) : [];
  return [
    "Ты обогащаешь карточку события в Валенсии (Испания) для русскоязычной семейной афиши.",
    web && links.length
      ? `Источники события: ${links.join(" , ")}. ОТКРОЙ их (WebFetch) и прочитай содержимое, чтобы ЗАЗЕМЛИТЬ факты (точный адрес, район, часы работы, цена). Для КАЖДОГО добавленного/уточнённого факта добавь запись в citations[] с url источника. НЕ выдумывай даты/цены/адреса — если факт не подтверждён источником или текстом карточки, оставь null.`
      : "Опирайся ТОЛЬКО на текст карточки ниже; НЕ выдумывай факты — неизвестное оставляй null.",
    "Верни ТОЛЬКО JSON без markdown в форме: " + SCHEMA_HINT,
    "title_ru / description_ru — на русском (переведи/перефразируй кратко, 1–2 предложения); confidence — твоя уверенность 0..1.",
    "КАРТОЧКА:",
    `title: ${row.title ?? ""}`,
    `description: ${row.description ?? ""}`,
    row.raw_excerpt ? `excerpt: ${String(row.raw_excerpt).slice(0, 1500)}` : "",
    row.source_url ? `source_url: ${row.source_url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// PURE: pull the first balanced-ish JSON object out of noisy CLI stdout. claude -p may
// wrap the object in prose/markdown despite instructions; the greedy { … } match is the
// same defensive extraction the telegram crawler uses.
export function extractJsonObject(stdout: string): EnrichmentResult {
  const m = stdout.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("enrich: no JSON object found in claude -p output");
  return JSON.parse(m[0]) as EnrichmentResult;
}

// PURE: assemble the `claude -p` argv. Grounded (web) calls MUST whitelist WebFetch — in
// -p (non-interactive) mode the tool is otherwise BLOCKED: the model just asks for
// permission and returns no JSON, silently breaking grounding (proven by the T139
// model-tiering eval). Translation-only calls need no tools.
export function buildClaudeArgs(prompt: string, opts: { web: boolean; model: string }): string[] {
  const args = ["-p", prompt, "--model", opts.model];
  if (opts.web) args.push("--allowedTools", "WebFetch");
  return args;
}

// PURE: per-path model floor (T139 eval). Translation (web=false) is safe + fastest on
// `haiku`; grounded extraction (web=true) needs `sonnet` (on a dead/unreachable link
// haiku gives up with an empty result, while sonnet self-recovers to the real page and
// cites grounded facts). `override` (opts.model) pins BOTH paths; else env per path.
export function pickEnrichModel(
  web: boolean,
  override?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (override) return override;
  return web ? env.ENRICH_MODEL_WEB ?? "sonnet" : env.ENRICH_MODEL ?? "haiku";
}

export function createClaudeEnrichClient(opts: ClaudeEnrichOptions = {}): EnrichClient {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const maxBuffer = opts.maxBuffer ?? 8 * 1024 * 1024;
  const bin = opts.bin ?? "claude";
  return {
    supportsWeb: true,
    // Headline/audit fallback only; the ACTUAL per-call model is recorded on each result
    // below (so the audit reflects haiku-vs-sonnet per path, not a single static value).
    model: opts.model ?? process.env.ENRICH_MODEL_WEB ?? "sonnet",
    async enrich(row: EnrichInput, callOpts?: { web?: boolean }): Promise<EnrichmentResult> {
      const web = callOpts?.web ?? false;
      const model = pickEnrichModel(web, opts.model);
      const prompt = buildEnrichPrompt(row, web);
      const stdout = opts.run
        ? await opts.run(prompt)
        : (await execFileP(bin, buildClaudeArgs(prompt, { web, model }), { timeout: timeoutMs, maxBuffer })).stdout;
      const result = extractJsonObject(stdout);
      if (!result.model) result.model = model; // record the ACTUAL per-path model (audit / tiering)
      return result;
    },
  };
}

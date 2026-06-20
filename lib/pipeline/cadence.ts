// Adaptive ingestion cadence (sub-area A, research A6) — PURE module: no DB, no
// network, no clock except the nowMs passed in. The dispatcher (dispatcher.ts) reads
// per-source state, asks this module for the next poll interval, and persists it.
//
// The model: each source is polled on its own interval. When a fetch returns NEW
// items the interval relaxes toward the observed gap between changes (×0.33, so we
// catch the next change with margin); when it returns 304/unchanged the interval
// backs off ×1.5 per consecutive miss; on errors it backs off ×2 per failure. Every
// interval is clamped to the source's [min,max] window (or per-type defaults).

export type SourceType = "telegram" | "web" | "ticketing" | "api" | string;

export interface CadenceWindow {
  min: number;
  max: number;
}

// Per-type defaults (research A6 / T014). Telegram channels churn fast (10m–3h);
// web pages are slower (1h–24h); ticketing/api feeds slowest (2h–24h).
export function cadenceDefaults(type?: SourceType | null): CadenceWindow {
  switch (type) {
    case "telegram":
      return { min: 600, max: 10800 };
    case "ticketing":
    case "api":
      return { min: 7200, max: 86400 };
    case "web":
    default:
      return { min: 3600, max: 86400 };
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// Relax toward a third of the observed change gap, clamped to the window. When the
// gap is unknown (null/0 — never observed a change yet) start at the floor (min).
export function computePollInterval(args: {
  observedGapSec?: number | null;
  minIntervalSec: number;
  maxIntervalSec: number;
}): number {
  const { observedGapSec, minIntervalSec, maxIntervalSec } = args;
  if (!observedGapSec) return minIntervalSec;
  return clamp(Math.round(observedGapSec * 0.33), minIntervalSec, maxIntervalSec);
}

// Unchanged (304/no new items): geometric back-off ×1.5 per consecutive miss.
export function backoffUnchanged(baseSec: number, consecutiveUnchanged: number, maxSec: number): number {
  return clamp(Math.round(baseSec * Math.pow(1.5, consecutiveUnchanged)), baseSec, maxSec);
}

// Error: faster geometric back-off ×2 per consecutive failure.
export function backoffError(baseSec: number, failCount: number, maxSec: number): number {
  return clamp(Math.round(baseSec * Math.pow(2, failCount)), baseSec, maxSec);
}

// ISO with stripped ms (mirrors util.nowIso) for the next due timestamp.
export function nextDueIso(nowMs: number, intervalSec: number): string {
  return new Date(nowMs + intervalSec * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

export interface DueSource {
  enabled?: number | null;
  next_due_at?: string | null;
  [k: string]: any;
}

// Due = never scheduled, or its due time has arrived. ISO strings compare
// lexicographically in UTC so a string comparison is correct here.
export function isDue(source: DueSource, nowIso: string): boolean {
  return !source.next_due_at || source.next_due_at <= nowIso;
}

// Enabled + due, ordered nulls-first (never-polled go first) then ascending by
// next_due_at (most overdue first).
export function selectDue<T extends DueSource>(sources: T[], nowIso: string): T[] {
  return sources
    .filter((s) => s.enabled === 1 && isDue(s, nowIso))
    .sort((a, b) => {
      if (!a.next_due_at && !b.next_due_at) return 0;
      if (!a.next_due_at) return -1;
      if (!b.next_due_at) return 1;
      return a.next_due_at < b.next_due_at ? -1 : a.next_due_at > b.next_due_at ? 1 : 0;
    });
}

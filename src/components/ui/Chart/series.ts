import type { ChartSeries, ChartX, ResolvedSeries } from "./types";

/** The palette has eight categorical slots. There is no ninth. */
export const SERIES_SLOTS = 8;
export const OTHER_LABEL = "Other";

/**
 * Slot -> token. Fixed order, never cycled: slot 0 is always --series-1, and a
 * slot past the eighth is always --series-other. Generating a hue, or wrapping
 * back to --series-1, would make two entities share a colour.
 */
export function slotColor(slot: number): string {
  return slot >= 0 && slot < SERIES_SLOTS
    ? `var(--series-${slot + 1})`
    : "var(--series-other)";
}

/**
 * Assigns each series its palette slot.
 *
 * The tail (slot >= 8) folds into the "Other" colour, but the series are NOT
 * summed into one. Summing is only meaningful for an additive measure, and this
 * primitive has no domain knowledge — it cannot know whether it is holding trip
 * counts (summable) or p99 latencies (not). So the tail keeps its marks and its
 * real names in the tooltip and the table; only its *colour* collapses. The
 * legend shows a single "Other" entry, which is the honest reading: these are
 * the tail, tell them apart in the table.
 */
export function resolveSeries(series: ChartSeries[]): ResolvedSeries[] {
  return series.map((s, index) => {
    const slot = s.colorSlot ?? index;
    const isOther = slot < 0 || slot >= SERIES_SLOTS;
    return {
      name: s.name,
      points: s.points,
      color: slotColor(slot),
      slot: isOther ? -1 : slot,
      isOther,
    };
  });
}

export interface LegendEntry {
  name: string;
  color: string;
}

/** One entry per colour: every folded series shares the single "Other" key. */
export function legendEntries(resolved: ResolvedSeries[]): LegendEntry[] {
  const out: LegendEntry[] = [];
  let hasOther = false;
  for (const s of resolved) {
    if (s.isOther) {
      if (hasOther) continue;
      hasOther = true;
      out.push({ name: OTHER_LABEL, color: s.color });
      continue;
    }
    out.push({ name: s.name, color: s.color });
  }
  return out;
}

/** True when every x on every series is numeric — the only case with a real x scale. */
export function isNumericX(series: ResolvedSeries[]): boolean {
  let seen = false;
  for (const s of series) {
    for (const p of s.points) {
      if (typeof p.x !== "number" || !Number.isFinite(p.x)) return false;
      seen = true;
    }
  }
  return seen;
}

/** Distinct x values, in order of first appearance — never re-sorted. */
export function categoriesOf(series: ResolvedSeries[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of series) {
    for (const p of s.points) {
      const key = String(p.x);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/** Value lookup by category, for the band-scaled forms and the table view. */
export function byCategory(series: ResolvedSeries): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const p of series.points) map.set(String(p.x), p.y);
  return map;
}

export function yExtent(series: ResolvedSeries[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const p of s.points) {
      if (p.y === null || !Number.isFinite(p.y)) continue;
      if (p.y < min) min = p.y;
      if (p.y > max) max = p.y;
    }
  }
  return Number.isFinite(min) ? [min, max] : [0, 1];
}

export function xExtent(series: ResolvedSeries[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const p of s.points) {
      const x = p.x as number;
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  return Number.isFinite(min) ? [min, max] : [0, 1];
}

export type XKey = ChartX;

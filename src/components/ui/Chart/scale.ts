/* Scales and tick maths. No React, no DOM — just numbers in, numbers out. */

export interface LinearScale {
  (value: number): number;
  invert: (pixel: number) => number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(
  domain: [number, number],
  range: [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  // A zero-width domain would divide by zero; pin it to the range's start.
  const span = d1 - d0 || 1;
  const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as LinearScale;
  scale.invert = (pixel: number) => d0 + ((pixel - r0) / (r1 - r0 || 1)) * span;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

function niceNum(x: number, round: boolean): number {
  const exp = Math.floor(Math.log10(x));
  const f = x / 10 ** exp;
  let nf: number;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

/**
 * Clean tick values (…/1000/2000/…) spanning [min, max]. The returned array's
 * ends become the axis domain, so gridlines land exactly on the plot's edges
 * rather than floating somewhere inside it.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    // A flat series still needs an axis. Open a symmetric window around it.
    const pad = Math.abs(min) || 1;
    min -= pad;
    max += pad;
  }
  // Step straight off the real span. Rounding the span *first* (the textbook
  // Heckbert opener) inflates it — a 0–81 axis reads its span as 100, divides
  // to 33, rounds up to 50, and ships three gridlines for a plot that wants six.
  const step = niceNum((max - min) / Math.max(1, count - 1), true);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out: number[] = [];
  // Accumulating `v += step` drifts on floats; multiply out from the start.
  const steps = Math.round((end - start) / step);
  for (let i = 0; i <= steps; i++) {
    const v = start + i * step;
    // Re-round to the step's own precision so 0.30000000000000004 never ships.
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

/**
 * Ticks plus the domain they imply.
 *
 * `includeZero` is on for bars and areas — a filled mark's length *is* the
 * value, so a non-zero baseline states a falsehood. Lines and scatters read as
 * position, not length, so they get a tight window on the data instead.
 */
export function yAxis(
  min: number,
  max: number,
  includeZero: boolean,
  count = 5,
): { ticks: number[]; domain: [number, number] } {
  const lo = includeZero ? Math.min(0, min) : min;
  const hi = includeZero ? Math.max(0, max) : max;
  const ticks = niceTicks(lo, hi, count);
  const first = ticks[0] ?? 0;
  const last = ticks[ticks.length - 1] ?? 1;
  return { ticks, domain: [first, last] };
}

/** Compact enough for an axis, exact enough to trust. Matches the design's "1,500". */
export function formatValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e4) return `${trim(value / 1e3)}K`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function trim(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

/**
 * Every k-th index, where k is the smallest stride that keeps labels apart.
 * Long category labels are meant to go horizontal (see BarsH); this only keeps
 * a dense *time* axis from turning into a smudge.
 */
export function tickStride(count: number, slotWidth: number, labelWidth: number): number {
  if (count <= 1 || slotWidth <= 0) return 1;
  return Math.max(1, Math.ceil(labelWidth / slotWidth));
}

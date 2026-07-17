/* Compare — view model.
 *
 * The sidebar is prop-driven: it renders whatever set of branches it is handed,
 * in whatever order they arrive. This file holds the pure shapes and maths that
 * make the set read as one comparison — the shared scale and the fixed colour
 * assignment — with no React and no knowledge of how the branches got here.
 *
 * It deliberately does NOT import from src/trigger. The wire shape a branch run
 * publishes lives with the task; this is the shape the UI consumes. The route
 * that owns the realtime subscription maps one to the other, so neither layer
 * reaches across the boundary. */

import { slotColor } from "@/components/ui/Chart";
import { yAxis } from "@/components/ui/Chart/scale";

/** A branch as the sidebar sees it, at whatever stage it has reached. */
export interface BranchView {
  id: string;
  label: string;
  /** The varied dimension's value, e.g. "excl. airport". */
  description?: string;
  /**
   * The palette slot this branch owns, fixed when the fork was launched. The UI
   * treats this as authoritative and NEVER re-derives colour from array
   * position — that is what lets a culled branch leave the survivors' colours
   * untouched.
   */
  colorSlot: number;
  /**
   * queued  — enqueued, its run not yet reporting.
   * running — the query is in flight.
   * complete — points and headline are in.
   * failed  — the run errored; `error` says how.
   */
  status: "queued" | "running" | "complete" | "failed";
  points: { x: string | number; y: number | null }[];
  headline: number | null;
  /** Percent change vs the base reading, when known. */
  delta: number | null;
  error?: string | null;
}

/** The whole session the sidebar renders. */
export interface CompareView {
  base: {
    question: string;
    metricLabel: string;
    unit?: string;
    varying: string;
  };
  branches: BranchView[];
}

/** A ready-made way to vary the question, offered in the "add a variant" panel. */
export interface VariantSuggestion {
  id: string;
  label: string;
  description?: string;
}

/** The colour a branch is drawn in — its fixed slot, as a token reference. */
export function branchColor(branch: Pick<BranchView, "colorSlot">): string {
  return slotColor(branch.colorSlot);
}

/**
 * The one scale every small multiple shares.
 *
 * Computed across every branch that has data, so the axis is the same on all of
 * them and the eye compares the DATA, not the framing — a variant whose line
 * sits low sits low against the same gridlines as one that sits high. A branch
 * still loading or failed contributes nothing yet; the scale re-derives as more
 * land, which is honest (it only ever claims to span what it has seen).
 *
 * Zero is included: the tiles compare magnitudes side by side, and a shared zero
 * baseline is what stops a tall-looking mini-chart from being an artefact of a
 * clipped axis.
 */
export function sharedYScale(branches: BranchView[]): {
  domain: [number, number];
  ticks: number[];
} {
  let min = Infinity;
  let max = -Infinity;
  for (const branch of branches) {
    for (const point of branch.points) {
      if (point.y === null || !Number.isFinite(point.y)) continue;
      if (point.y < min) min = point.y;
      if (point.y > max) max = point.y;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { domain: [0, 1], ticks: [0, 1] };
  }
  const { ticks, domain } = yAxis(min, max, true);
  return { domain, ticks };
}

/**
 * The longest series in the set — the shared x resolution. Every small multiple
 * plots its points across the same number of slots, so a 7-point line and a
 * 5-point line don't stretch to different widths and read as different windows.
 */
export function sharedXCount(branches: BranchView[]): number {
  let max = 0;
  for (const branch of branches) {
    if (branch.points.length > max) max = branch.points.length;
  }
  return Math.max(1, max);
}

/** True once at least one branch has a real reading to scale against. */
export function hasAnyData(branches: BranchView[]): boolean {
  return branches.some((b) =>
    b.points.some((p) => p.y !== null && Number.isFinite(p.y)),
  );
}

// --- number formatting -----------------------------------------------------

const NUM = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** "$4.38", "20%", "1.4×", or a plain number — matching how chat showed it. */
export function formatMetric(value: number | null, unit?: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const n = value.toLocaleString("en-US", {
    minimumFractionDigits: unit === "$" ? 2 : 0,
    maximumFractionDigits: 2,
  });
  if (!unit) return NUM.format(value);
  return unit === "$" ? `$${n}` : `${n}${unit}`;
}

/** A signed percent for the delta chip: "+6.2%", "−21.3%". */
export function formatDelta(delta: number | null): string | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  return `${sign}${Math.abs(delta).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

/**
 * The label the shared-scale note wears, e.g. "shared scale $0–$6". Purely
 * descriptive — the scale itself is `sharedYScale`; this just says it out loud.
 */
export function sharedScaleLabel(
  scale: { domain: [number, number] },
  unit?: string,
): string {
  const [lo, hi] = scale.domain;
  return `shared scale ${formatMetric(lo, unit)}–${formatMetric(hi, unit)}`;
}

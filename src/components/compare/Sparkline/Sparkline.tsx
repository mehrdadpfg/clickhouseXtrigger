import { useId } from "react";
import { linearScale } from "@/components/ui/scale";
import styles from "./Sparkline.module.css";

/**
 * One small multiple, on an INJECTED scale.
 *
 * The point of a small multiple is that the axis is not its own — it is the
 * set's. So this takes the shared y-domain and the shared x-count from its
 * parent and never computes its own extent; two Sparklines handed the same
 * `domain` and `xCount` are directly comparable by eye, which is the whole
 * reason the compare surface exists. Colour is passed in too (the branch's fixed
 * slot), so this holds no palette logic and nothing here can repaint on a cull.
 */

const VB_W = 380;
const VB_H = 54;
/** Gridlines sit a hair inside the box so the top/bottom strokes aren't clipped. */
const PAD_Y = 4;

export interface SparklinePoint {
  x: string | number;
  y: number | null;
}

export interface SparklineProps {
  points: SparklinePoint[];
  /** The shared y-domain — same on every sibling. */
  domain: [number, number];
  /** The shared tick values, drawn as gridlines. */
  ticks: number[];
  /** The set's longest series length — the shared x resolution. */
  xCount: number;
  /** A token reference, e.g. "var(--series-2)". Never a hex. */
  color: string;
  /** Names the line for assistive tech (the variant label). */
  label: string;
}

export function Sparkline({
  points,
  domain,
  ticks,
  xCount,
  color,
  label,
}: SparklineProps) {
  const gradientId = useId();

  const yScale = linearScale(domain, [VB_H - PAD_Y, PAD_Y]);
  // Points are placed by index across the shared count, so a shorter series
  // occupies the left of the same axis rather than being stretched to fill it.
  const denom = Math.max(1, xCount - 1);
  const xAt = (index: number) => (index / denom) * VB_W;

  // Break the polyline into runs of consecutive real values: a null is a gap,
  // not a zero, so the line lifts across it rather than diving to the floor.
  const runs: string[] = [];
  let current: string[] = [];
  points.forEach((point, index) => {
    if (point.y === null || !Number.isFinite(point.y)) {
      if (current.length) runs.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${xAt(index).toFixed(1)},${yScale(point.y).toFixed(1)}`);
  });
  if (current.length) runs.push(current.join(" "));

  // The last real point, marked — the value the tile's headline names.
  let lastIndex = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    const y = points[i]!.y;
    if (y !== null && Number.isFinite(y)) {
      lastIndex = i;
      break;
    }
  }

  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}, on the shared scale`}
    >
      {/* Shared gridlines. Every sibling draws these at the same y — the visual
          proof the axis is common. */}
      {ticks.map((tick) => {
        const y = yScale(tick);
        return (
          <line
            key={tick}
            className={styles.grid}
            x1={0}
            x2={VB_W}
            y1={y}
            y2={y}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}

      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.16" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>

      {runs.map((run, i) => (
        <polyline
          key={i}
          className={styles.line}
          points={run}
          style={{ stroke: color }}
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {lastIndex >= 0 && (
        <circle
          className={styles.dot}
          cx={xAt(lastIndex)}
          cy={yScale(points[lastIndex]!.y as number)}
          r={2.5}
          style={{ fill: color }}
        />
      )}
    </svg>
  );
}

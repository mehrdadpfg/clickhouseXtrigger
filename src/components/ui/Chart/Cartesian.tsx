"use client";

import { useMemo, useState } from "react";
import styles from "./Chart.module.css";
import { Tooltip, type TooltipRow } from "./Tooltip";
import { formatValue, linearScale, niceTicks, tickStride, yAxis } from "./scale";
import { byCategory, categoriesOf, isNumericX, xExtent, yExtent } from "./series";
import type { ChartX, ChartXAxis, ChartYAxis, ResolvedSeries } from "./types";

export type CartesianKind = "line" | "area" | "bar" | "scatter";

interface CartesianProps {
  kind: CartesianKind;
  series: ResolvedSeries[];
  title: string;
  x?: ChartXAxis;
  y?: ChartYAxis;
  width: number;
  height: number;
}

/* Fixed specs — the data is the only thing allowed to be loud. */
const TOP = 10;
const AXIS_BAND = 20;
const BAR_MAX = 24; // never fill the band; the leftover is air
const GAP = 2; // the surface gap, between every touching mark
const MARKER_R = 4.5; // >= 8px across
const RING = 2; // surface ring, so overlapping marks stay legible
const CORNER = 4; // rounded data-end, square at the baseline
const TICK_CHAR = 5.6; // ~9.5px JetBrains Mono
const LABEL_CHAR = 6.2; // ~11px JetBrains Mono
const LABEL_MIN_GAP = 12; // below this, end-labels have collided
const HIT_RADIUS = 24; // the pointer only has to be closest, not dead-centre

interface ScreenPoint {
  x: number;
  y: number | null;
  raw: ChartX;
  value: number | null;
}

function runs(points: ScreenPoint[]): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  for (const p of points) {
    if (p.y === null) {
      // A null is a gap, not a zero — close the run and leave a hole.
      if (current.length > 0) out.push(current);
      current = [];
      continue;
    }
    current.push({ x: p.x, y: p.y });
  }
  if (current.length > 0) out.push(current);
  return out;
}

function linePath(run: { x: number; y: number }[]): string {
  return run.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

function areaPath(run: { x: number; y: number }[], base: number): string {
  const first = run[0];
  const last = run[run.length - 1];
  if (!first || !last) return "";
  return `M${first.x},${base} ${run.map((p) => `L${p.x},${p.y}`).join(" ")} L${last.x},${base} Z`;
}

/** Rounded at the data end, square at the baseline — the length is the value. */
function barPath(
  x: number,
  w: number,
  yTop: number,
  yBottom: number,
  roundTop: boolean,
): string {
  const h = yBottom - yTop;
  if (h <= 0.5) return "";
  const r = Math.min(CORNER, w / 2, h);
  if (roundTop) {
    return `M${x},${yBottom} L${x},${yTop + r} Q${x},${yTop} ${x + r},${yTop} L${x + w - r},${yTop} Q${x + w},${yTop} ${x + w},${yTop + r} L${x + w},${yBottom} Z`;
  }
  return `M${x},${yTop} L${x},${yBottom - r} Q${x},${yBottom} ${x + r},${yBottom} L${x + w - r},${yBottom} Q${x + w},${yBottom} ${x + w},${yBottom - r} L${x + w},${yTop} Z`;
}

export function Cartesian({ kind, series, title, x, y, width, height }: CartesianProps) {
  const [active, setActive] = useState<
    | { type: "x"; index: number }
    | { type: "mark"; s: number; i: number }
    | null
  >(null);

  const fmtY = y?.format ?? formatValue;
  const fmtX =
    x?.format ?? ((v: ChartX) => (typeof v === "number" ? formatValue(v) : String(v)));

  const geometry = useMemo(() => {
    // Bars are always banded; a bar needs a slot, not a coordinate.
    const numericX = kind === "bar" ? false : isNumericX(series);
    const categories = numericX ? [] : categoriesOf(series);

    const [yMin, yMax] = yExtent(series);
    // Bars and areas read as *length* from a baseline, so 0 must be on the axis
    // or the mark overstates the value. Lines and dots read as position.
    const includeZero = kind === "bar" || kind === "area";
    const { ticks, domain } = yAxis(yMin, yMax, includeZero);

    const plotH = height;
    const yS = linearScale(domain, [TOP + plotH, TOP]);

    // --- Direct labels: decided before the margins they cost. -----------------
    // >=2 series always get a legend; <=4 also get direct labels. One series
    // needs neither — the title already names it.
    const wantsDirect =
      (kind === "line" || kind === "area") && series.length >= 2 && series.length <= 4;

    const endYs: number[] = [];
    if (wantsDirect) {
      for (const s of series) {
        for (let i = s.points.length - 1; i >= 0; i--) {
          const p = s.points[i];
          if (p && p.y !== null && Number.isFinite(p.y)) {
            endYs.push(yS(p.y));
            break;
          }
        }
      }
    }
    // Converged lines: nudging labels apart detaches them from their line and
    // reads as noise. Drop them wholesale and let the legend carry identity.
    const sorted = [...endYs].sort((a, b) => a - b);
    const collided = sorted.some((v, i) => {
      const prev = sorted[i - 1];
      return prev !== undefined && v - prev < LABEL_MIN_GAP;
    });

    const nameW = Math.max(0, ...series.map((s) => s.name.length)) * LABEL_CHAR + 14;
    let showDirect = wantsDirect && !collided;
    // At ~600px a long series name would eat the plot. Legend-only is better
    // than a squeezed plot.
    if (showDirect && nameW > width * 0.3) showDirect = false;

    const tickLabels = ticks.map((t) => fmtY(t));
    const left = Math.ceil(Math.max(0, ...tickLabels.map((l) => l.length)) * TICK_CHAR) + 10;
    const right = showDirect ? Math.ceil(nameW) : 10;
    const plotW = Math.max(10, width - left - right);

    // --- X placement ---------------------------------------------------------
    // Scatter dots sit *on* their coordinate, so inset the range by the marker
    // radius or the extremes get sliced by the plot edge.
    const inset = kind === "scatter" ? MARKER_R + RING : 0;
    const xS = numericX
      ? linearScale(xExtent(series), [left + inset, left + plotW - inset])
      : null;
    const bandW = categories.length > 0 ? plotW / categories.length : plotW;
    const bandCentre = (i: number) => left + (i + 0.5) * bandW;

    const plotted = series.map((s) => {
      if (numericX && xS) {
        const points: ScreenPoint[] = [...s.points]
          .sort((a, b) => (a.x as number) - (b.x as number))
          .map((p) => ({
            x: xS(p.x as number),
            y: p.y === null || !Number.isFinite(p.y) ? null : yS(p.y),
            raw: p.x,
            value: p.y,
          }));
        return { series: s, points };
      }
      const lookup = byCategory(s);
      const points: ScreenPoint[] = categories.map((c, i) => {
        const v = lookup.has(c) ? (lookup.get(c) ?? null) : null;
        return {
          x: bandCentre(i),
          y: v === null || !Number.isFinite(v) ? null : yS(v),
          raw: c,
          value: v,
        };
      });
      return { series: s, points };
    });

    // The x positions the crosshair can snap to.
    const snapXs = numericX
      ? Array.from(
          new Set(series.flatMap((s) => s.points.map((p) => p.x as number))),
        ).sort((a, b) => a - b)
      : categories.map((_, i) => i);

    // --- X ticks -------------------------------------------------------------
    let xTicks: { pos: number; label: string }[] = [];
    if (numericX && xS) {
      const [x0, x1] = xS.domain;
      const candidates = niceTicks(x0, x1, 5).filter((t) => t >= x0 && t <= x1);
      const labels = candidates.map((t) => fmtX(t));
      const labelW = Math.max(0, ...labels.map((l) => l.length)) * TICK_CHAR + 12;
      const stride = tickStride(
        candidates.length,
        plotW / Math.max(1, candidates.length),
        labelW,
      );
      xTicks = candidates
        .map((t, i) => ({ t, i }))
        .filter(({ i }) => i % stride === 0)
        .map(({ t }) => ({ pos: xS(t), label: fmtX(t) }));
    } else {
      const labels = categories.map((c) => fmtX(c));
      const labelW = Math.max(0, ...labels.map((l) => l.length)) * TICK_CHAR + 10;
      const stride = tickStride(categories.length, bandW, labelW);
      xTicks = categories
        .map((c, i) => ({ c, i }))
        .filter(({ i }) => i % stride === 0)
        .map(({ c, i }) => ({ pos: bandCentre(i), label: fmtX(c) }));
    }

    // --- Bar geometry --------------------------------------------------------
    const n = series.length;
    const usable = bandW * 0.78; // the rest is air between groups
    const rawW = (usable - GAP * (n - 1)) / n;
    const barW = Math.max(1, Math.min(BAR_MAX, rawW));
    const groupW = barW * n + GAP * (n - 1);

    return {
      numericX,
      categories,
      ticks,
      yS,
      xS,
      bandW,
      bandCentre,
      plotted,
      snapXs,
      xTicks,
      left,
      right,
      plotW,
      plotH,
      barW,
      groupW,
      showDirect,
      baseline: yS(Math.max(domain[0], Math.min(0, domain[1]))),
    };
  }, [kind, series, width, height, fmtX, fmtY]);

  const {
    numericX,
    categories,
    ticks,
    yS,
    plotted,
    snapXs,
    xTicks,
    left,
    plotW,
    plotH,
    barW,
    groupW,
    showDirect,
    baseline,
  } = geometry;

  const svgH = TOP + plotH + AXIS_BAND;
  const usesCrosshair = kind === "line" || kind === "area";

  /* ---- Hover ------------------------------------------------------------- */

  function onCrosshairMove(event: React.PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left + left;
    if (snapXs.length === 0) return;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < snapXs.length; i++) {
      const pos = numericX && geometry.xS ? geometry.xS(snapXs[i] as number) : geometry.bandCentre(i);
      const d = Math.abs(pos - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setActive({ type: "x", index: best });
  }

  function onScatterMove(event: React.PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left + left;
    const py = event.clientY - box.top + TOP;
    let foundS = -1;
    let foundI = -1;
    let bestD = HIT_RADIUS;
    for (let s = 0; s < plotted.length; s++) {
      const points = plotted[s]?.points ?? [];
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!p || p.y === null) continue;
        const d = Math.hypot(p.x - px, p.y - py);
        if (d < bestD) {
          bestD = d;
          foundS = s;
          foundI = i;
        }
      }
    }
    setActive(foundS >= 0 ? { type: "mark", s: foundS, i: foundI } : null);
  }

  /* ---- Tooltip model ----------------------------------------------------- */

  let tooltip: { x: number; y: number; head: string; rows: TooltipRow[] } | null = null;

  if (active?.type === "x") {
    const rows: TooltipRow[] = [];
    let anchorX = 0;
    let anchorY = TOP;
    for (const { series: s, points } of plotted) {
      const p = points[active.index];
      if (!p) continue;
      anchorX = p.x;
      if (p.value === null) continue;
      if (p.y !== null) anchorY = Math.min(anchorY === TOP ? p.y : anchorY, p.y);
      rows.push({ name: s.name, color: s.color, value: fmtY(p.value) });
    }
    const head = plotted[0]?.points[active.index];
    if (rows.length > 0 && head) {
      tooltip = { x: anchorX, y: Math.max(TOP, anchorY - 8), head: fmtX(head.raw), rows };
    }
  } else if (active?.type === "mark") {
    const entry = plotted[active.s];
    const point = entry?.points[active.i];
    if (entry && point && point.value !== null) {
      if (kind === "bar") {
        // Triggered by the mark, but the readout lists every series at that x —
        // the reader never has to hunt for a second bar to compare.
        const rows: TooltipRow[] = [];
        for (const { series: s, points } of plotted) {
          const p = points[active.i];
          if (!p || p.value === null) continue;
          rows.push({ name: s.name, color: s.color, value: fmtY(p.value) });
        }
        tooltip = {
          x: geometry.bandCentre(active.i),
          y: Math.max(TOP, (point.y ?? TOP) - 8),
          head: fmtX(point.raw),
          rows,
        };
      } else {
        tooltip = {
          x: point.x,
          y: Math.max(TOP, (point.y ?? TOP) - 8),
          head: fmtX(point.raw),
          rows: [
            { name: entry.series.name, color: entry.series.color, value: fmtY(point.value) },
          ],
        };
      }
    }
  }

  const crosshairX =
    active?.type === "x"
      ? (plotted[0]?.points[active.index]?.x ?? null)
      : null;

  return (
    <div className={styles.plot}>
      <svg
        width={width}
        height={svgH}
        role="img"
        aria-label={title}
        className={styles.svg}
      >
        {/* Grid: solid hairlines, one step off the surface. Never dashed. */}
        {ticks.map((t) => (
          <line
            key={t}
            x1={left}
            x2={left + plotW}
            y1={yS(t)}
            y2={yS(t)}
            className={t === ticks[0] ? styles.axisLine : styles.gridLine}
          />
        ))}

        {ticks.map((t) => (
          <text
            key={t}
            x={left - 8}
            y={yS(t)}
            textAnchor="end"
            dominantBaseline="middle"
            className={`tnum ${styles.tickText}`}
          >
            {fmtY(t)}
          </text>
        ))}

        {xTicks.map((t, i) => (
          <text
            key={`${t.label}-${i}`}
            x={t.pos}
            y={TOP + plotH + 13}
            textAnchor="middle"
            className={`tnum ${styles.tickText}`}
          >
            {t.label}
          </text>
        ))}

        {/* Areas first — a 10% wash, never a saturated block. */}
        {kind === "area" &&
          plotted.map(({ series: s, points }) =>
            runs(points).map((run, i) => (
              <path
                key={`${s.name}-fill-${i}`}
                d={areaPath(run, baseline)}
                fill={s.color}
                fillOpacity={0.1}
                stroke="none"
              />
            )),
          )}

        {(kind === "line" || kind === "area") &&
          plotted.map(({ series: s, points }) =>
            runs(points).map((run, i) => (
              <path
                key={`${s.name}-line-${i}`}
                d={linePath(run)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )),
          )}

        {kind === "bar" &&
          plotted.map(({ series: s, points }, si) =>
            points.map((p, i) => {
              if (p.y === null) return null;
              const gx = geometry.bandCentre(i) - groupW / 2 + si * (barW + GAP);
              const up = p.y <= baseline;
              const d = barPath(
                gx,
                barW,
                up ? p.y : baseline,
                up ? baseline : p.y,
                up,
              );
              if (!d) return null;
              const isActive =
                active?.type === "mark" && active.s === si && active.i === i;
              return (
                <path
                  key={`${s.name}-bar-${i}`}
                  d={d}
                  fill={s.color}
                  className={isActive ? styles.markActive : undefined}
                />
              );
            }),
          )}

        {kind === "scatter" &&
          plotted.map(({ series: s, points }, si) =>
            points.map((p, i) => {
              if (p.y === null) return null;
              const isActive =
                active?.type === "mark" && active.s === si && active.i === i;
              return (
                <circle
                  key={`${s.name}-dot-${i}`}
                  cx={p.x}
                  cy={p.y}
                  r={MARKER_R}
                  fill={s.color}
                  strokeWidth={RING}
                  className={`${styles.markRing} ${isActive ? styles.markActive : ""}`}
                />
              );
            }),
          )}

        {/* Direct labels: the end dot carries the colour, the text stays ink. */}
        {showDirect &&
          plotted.map(({ series: s, points }) => {
            let last: ScreenPoint | undefined;
            for (let i = points.length - 1; i >= 0; i--) {
              const p = points[i];
              if (p && p.y !== null) {
                last = p;
                break;
              }
            }
            if (!last || last.y === null) return null;
            return (
              <g key={`${s.name}-direct`}>
                <circle
                  cx={last.x}
                  cy={last.y}
                  r={MARKER_R}
                  fill={s.color}
                  strokeWidth={RING}
                  className={styles.markRing}
                />
                <text
                  x={last.x + MARKER_R + 6}
                  y={last.y}
                  dominantBaseline="middle"
                  className={styles.directLabel}
                >
                  {s.name}
                </text>
              </g>
            );
          })}

        {/* Crosshair: the reader aims at a category, never at a 2px line. */}
        {usesCrosshair && crosshairX !== null && (
          <>
            <line
              x1={crosshairX}
              x2={crosshairX}
              y1={TOP}
              y2={TOP + plotH}
              className={styles.crosshair}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {plotted.map(({ series: s, points }) => {
              const p = active?.type === "x" ? points[active.index] : undefined;
              if (!p || p.y === null) return null;
              return (
                <circle
                  key={`${s.name}-cross`}
                  cx={p.x}
                  cy={p.y}
                  r={MARKER_R}
                  fill={s.color}
                  strokeWidth={RING}
                  className={styles.markRing}
                />
              );
            })}
          </>
        )}

        {/* Hit layers, always last so nothing paints over them. */}
        {usesCrosshair && (
          <rect
            x={left}
            y={TOP}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onCrosshairMove}
            onPointerLeave={() => setActive(null)}
          />
        )}

        {kind === "scatter" && (
          <rect
            x={left}
            y={TOP}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onScatterMove}
            onPointerLeave={() => setActive(null)}
          />
        )}

        {/* Bars: the mark is the trigger, but the target is the whole band
            slice — it includes the surface gap and the full plot height. */}
        {kind === "bar" &&
          plotted.map(({ series: s, points }, si) =>
            points.map((p, i) => {
              if (p.y === null) return null;
              const gx = geometry.bandCentre(i) - groupW / 2 + si * (barW + GAP);
              return (
                <rect
                  key={`${s.name}-hit-${i}`}
                  x={gx - GAP}
                  y={TOP}
                  width={barW + GAP * 2}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={() => setActive({ type: "mark", s: si, i })}
                  onPointerLeave={() => setActive(null)}
                />
              );
            }),
          )}
      </svg>

      {tooltip && (
        <Tooltip
          x={tooltip.x}
          y={tooltip.y}
          width={width}
          head={tooltip.head}
          rows={tooltip.rows}
        />
      )}
    </div>
  );
}

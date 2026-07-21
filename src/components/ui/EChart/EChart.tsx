"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as echarts from "echarts";
import { exportChartPNG } from "./export";

/**
 * A thin, presentational ECharts mount. Takes a ready ECharts `option` (ours is
 * produced by flint-chart's assembleECharts) and renders it, on the Onyx theme.
 *
 * Pure UI: it knows nothing about the agent, the chart spec, or flint — just an
 * option in, a canvas out. The domain mapping lives with the caller.
 */

/** Reads the Onyx tokens off :root so the chart matches the rest of the app.
 *  Exported so an offscreen export twin can render on the exact same theme. */
export function onyxTheme(): object {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    s.getPropertyValue(name).trim() || fallback;

  const series = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    v(`--series-${n}`, "#93c5fd"),
  );
  const text = v("--text-secondary", "#d4d4d4");
  const muted = v("--text-muted", "#888888");
  const line = v("--border", "#1e1e1e");
  const grid = v("--border-subtle", "#1a1a1a");
  const font = v("--font-mono", "monospace");
  const raised = v("--raised", "#1a1a1a");
  const borderStrong = v("--border-strong", "#2a2a2a");

  const axis = {
    axisLine: { lineStyle: { color: line } },
    axisTick: { lineStyle: { color: line } },
    axisLabel: { color: muted, fontFamily: font, fontSize: 10 },
    splitLine: { lineStyle: { color: grid } },
  };

  return {
    color: series,
    backgroundColor: "transparent",
    textStyle: { color: text, fontFamily: font },
    title: { textStyle: { color: text } },
    legend: { textStyle: { color: text } },
    categoryAxis: axis,
    valueAxis: axis,
    logAxis: axis,
    timeAxis: axis,
    // flint sets only the tooltip's trigger, leaving ECharts' white default box —
    // a glaring light card on the Onyx surface. Style it onto the raised tier so
    // the hover matches the app. axisPointer (the crosshair) recolours too.
    tooltip: {
      // Keep the hover box inside the chart's own box — cards clip their overflow
      // (rounded corners), so an unconfined tooltip near an edge gets cut off.
      confine: true,
      backgroundColor: raised,
      borderColor: borderStrong,
      borderWidth: 1,
      padding: [6, 10],
      textStyle: { color: text, fontFamily: font, fontSize: 12 },
      extraCssText: "border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.55);",
      axisPointer: {
        lineStyle: { color: borderStrong },
        crossStyle: { color: borderStrong },
        shadowStyle: { color: "rgba(255,255,255,0.04)" },
      },
    },
  };
}

/** What a caller can drive on a mounted chart — used to download the figure. */
export interface EChartHandle {
  /** The live ECharts instance, or null before mount / after unmount. */
  getInstance(): echarts.ECharts | null;
  /** Download the current chart as a PNG on the app's dark surface. */
  exportPNG(filename?: string): void;
}

export const EChart = forwardRef<
  EChartHandle,
  {
    option: echarts.EChartsCoreOption;
    /**
     * The chart's height. A number is pixels (the chat's fixed-height tiles); a
     * CSS string like "100%" lets the chart fill a parent of a definite height
     * (the board's gridstack tiles). Either way the internal ResizeObserver keeps
     * ECharts in step with the box.
     */
    height?: number | string;
    /**
     * A mark was clicked — `name` is its category. Only wired where direct
     * manipulation is armed (the workspace), never on a thread tile: a
     * mis-click on a dashboard must not be able to fire a query.
     */
    onPick?: (name: string) => void;
    /**
     * Enable range selection and report the brushed x-extent as category
     * labels. Only meaningful on an ordered axis — a range across a ranked bar
     * chart is "these five bars", which is a selection, not a range.
     */
    onBrush?: (from: string, to: string) => void;
  }
>(function EChart({ option, height = 260, onPick, onBrush }, ref) {
  // Held in a ref so the chart is not re-initialised when the handler identity
  // changes — remounting ECharts on every parent render would kill the tooltip
  // mid-hover.
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onBrushRef = useRef(onBrush);
  onBrushRef.current = onBrush;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // init is client-only (needs a real DOM box) — hence "use client" + effect.
    const chart = echarts.init(el, onyxTheme(), { renderer: "canvas" });
    chartRef.current = chart;
    chart.setOption(option);

    if (onBrush) {
      // toolbox is what registers the brush action; it stays hidden because the
      // brush is armed permanently here rather than toggled from a toolbar.
      chart.setOption({
        toolbox: { show: false, feature: { brush: { type: ["lineX", "clear"] } } },
        brush: {
          toolbox: ["lineX", "clear"],
          xAxisIndex: 0,
          throttleType: "debounce",
          throttleDelay: 250,
          brushStyle: {
            borderWidth: 1,
            color: "rgba(55, 194, 194, 0.12)",
            borderColor: "rgba(55, 194, 194, 0.55)",
          },
        },
      });
      chart.dispatchAction({
        type: "takeGlobalCursor",
        key: "brush",
        brushOption: { brushType: "lineX", brushMode: "single" },
      });

      chart.on("brushEnd", (params: unknown) => {
        // A brush reports pixel ranges; the category axis maps them back to the
        // real x values, which is the only form the agent can act on.
        const areas = (params as { areas?: { coordRange?: number[] }[] }).areas;
        const range = areas?.[0]?.coordRange;
        if (!range || range.length < 2) return;

        const full = chart.getOption() as {
          xAxis?: { data?: unknown[]; type?: string }[];
          series?: { data?: unknown[] }[];
        };
        const categories = full.xAxis?.[0]?.data;
        const axisType = full.xAxis?.[0]?.type;

        let from: string;
        let to: string;

        if (axisType === "time") {
          // A time axis reports the range in epoch ms, which is unreadable and
          // lands between real points. Snap each end to the nearest x the series
          // actually has, so the window named back is one the data contains.
          const xs: number[] = [];
          for (const point of full.series?.[0]?.data ?? []) {
            const value = Array.isArray(point) ? point[0] : point;
            const ms = value instanceof Date ? value.getTime() : Number(value);
            if (Number.isFinite(ms)) xs.push(ms);
          }
          const snap = (target: number) =>
            xs.length === 0
              ? target
              : xs.reduce((best, x) =>
                  Math.abs(x - target) < Math.abs(best - target) ? x : best,
                );
          const a = snap(Math.min(range[0]!, range[1]!));
          const b = snap(Math.max(range[0]!, range[1]!));
          const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
          from = iso(a);
          to = iso(b);
        } else if (Array.isArray(categories) && categories.length > 0) {
          // Category axis: coordRange is in axis INDICES.
          const lo = Math.max(0, Math.ceil(range[0]!));
          const hi = Math.min(categories.length - 1, Math.floor(range[1]!));
          if (lo > hi) return;
          from = String(categories[lo] ?? "");
          to = String(categories[hi] ?? "");
        } else {
          // Value axis (a numeric x, e.g. a year): coordRange is already in data
          // units, so it is the answer — just ordered and trimmed to integers,
          // since a range of "2019.4 to 2022.7" is not a thing anyone means.
          const a = Math.round(Math.min(range[0]!, range[1]!));
          const b = Math.round(Math.max(range[0]!, range[1]!));
          from = String(a);
          to = String(b);
        }

        if (from && to) onBrushRef.current?.(from, to);
      });
    }

    chart.on("click", (params: { name?: string }) => {
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (name) onPickRef.current?.(name);
    });

    // Flint sizes to a target, but the reading column is fluid — track it.
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [option, onBrush]);

  useImperativeHandle(
    ref,
    () => ({
      getInstance: () => chartRef.current,
      exportPNG: (filename) => {
        const chart = chartRef.current;
        if (chart) exportChartPNG(chart, filename);
      },
    }),
    [],
  );

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height, ...(onPick ? { cursor: "pointer" } : {}) }}
      role="img"
    />
  );
});

"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts";

/**
 * A thin, presentational ECharts mount. Takes a ready ECharts `option` (ours is
 * produced by flint-chart's assembleECharts) and renders it, on the Onyx theme.
 *
 * Pure UI: it knows nothing about the agent, the chart spec, or flint — just an
 * option in, a canvas out. The domain mapping lives with the caller.
 */

/** Reads the Onyx tokens off :root so the chart matches the rest of the app. */
function onyxTheme(): object {
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

export function EChart({
  option,
  height = 260,
}: {
  option: echarts.EChartsCoreOption;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // init is client-only (needs a real DOM box) — hence "use client" + effect.
    const chart = echarts.init(el, onyxTheme(), { renderer: "canvas" });
    chart.setOption(option);

    // Flint sizes to a target, but the reading column is fluid — track it.
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [option]);

  return <div ref={ref} style={{ width: "100%", height }} role="img" />;
}

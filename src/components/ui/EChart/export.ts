"use client";

import * as echarts from "echarts";

/**
 * Chart export plumbing — the download side of the EChart mount.
 *
 * PNG comes straight off the live canvas instance; SVG can't (our charts render
 * on the canvas backend), so we spin up a throwaway offscreen chart on the SVG
 * backend with the same option + theme, serialise it, and dispose it.
 *
 * No colour literals live here beyond the one runtime fallback for --bg, which
 * mirrors what EChart.tsx does for its own theme fallbacks.
 */

/** A filesystem-safe stem from a chart title; "chart" when there's nothing. */
export function slugify(title: string | undefined, fallback = "chart"): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

/**
 * The page's dark surface, read at runtime so a saved PNG isn't a transparent
 * (renders white) rectangle. Not a styling literal — the token is the source of
 * truth; the fallback only covers a chart exported before tokens resolve.
 */
function pageBackground(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() ||
    "#0a0a0a"
  );
}

function triggerDownload(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Save the live chart as a 2x PNG on the app's dark surface. */
export function exportChartPNG(chart: echarts.ECharts, filename = "chart"): void {
  const url = chart.getDataURL({
    type: "png",
    pixelRatio: 2,
    backgroundColor: pageBackground(),
  });
  triggerDownload(url, `${filename}.png`);
}

/**
 * Save the chart as SVG. The visible chart is canvas-rendered and can't emit
 * SVG, so render an offscreen twin on the SVG backend at the same pixel size and
 * serialise that. Size is passed to init() explicitly because a detached node
 * has no layout box to measure.
 */
export function exportChartSVG(
  option: echarts.EChartsCoreOption,
  theme: object,
  width: number,
  height: number,
  filename = "chart",
): void {
  const el = document.createElement("div");
  const chart = echarts.init(el, theme, {
    renderer: "svg",
    width: Math.max(Math.round(width), 1),
    height: Math.max(Math.round(height), 1),
  });
  try {
    chart.setOption(option);
    const svg = chart.renderToSVGString();
    const url = URL.createObjectURL(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    );
    triggerDownload(url, `${filename}.svg`);
    // Give the click a tick to start before reclaiming the blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } finally {
    chart.dispose();
  }
}

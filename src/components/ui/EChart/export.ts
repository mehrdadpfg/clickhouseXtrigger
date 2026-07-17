"use client";

import * as echarts from "echarts";

/**
 * Chart download — a single PNG straight off the live canvas instance.
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

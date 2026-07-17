import { assembleECharts } from "flint-chart";
import type { EChartsCoreOption } from "echarts";

/**
 * Maps the agent's `renderChart` tool spec onto flint-chart, which compiles it
 * to an ECharts option. This is the one place that knows the tool contract, so
 * it lives with the chat turn, not in the pure EChart primitive.
 *
 * The spec shape mirrors the zod schema on the `renderChart` tool in
 * src/trigger/chat.ts — keep the two in sync. `chartType` is a flint template
 * name (flint validates it and throws on anything unknown, so this file doesn't
 * re-check the set); `encodings` maps each chart channel to a row field.
 */
export interface ChartSpec {
  chartType: string;
  title: string;
  encodings: Record<string, string>;
  data: Record<string, unknown>[];
  /** Horizontal orientation for bar-family charts (keeps long labels level). */
  horizontal?: boolean;
  /** Optional field → semantic hint (Quantity, Time, Percentage, …). */
  semanticTypes?: Record<string, string>;
}

/** Bar-family charts we can flip to horizontal by swapping the axes post-assembly. */
const FLIPPABLE = new Set(["Bar Chart", "Grouped Bar Chart", "Stacked Bar Chart", "Lollipop Chart"]);

/** 6000000 → "6M": short axis ticks so the plot isn't crowded out by digits. */
function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const n = Math.abs(value);
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (n >= 1e12) return `${trim(value / 1e12)}T`;
  if (n >= 1e9) return `${trim(value / 1e9)}B`;
  if (n >= 1e6) return `${trim(value / 1e6)}M`;
  if (n >= 1e3) return `${trim(value / 1e3)}K`;
  return String(value);
}

/**
 * flint bakes a fixed pixel layout from its baseSize — a pie with an 80px
 * radius, cartesian grids with 86px margins and a 120px axis-name gap. Those
 * never rescale, so a pie overflows a smaller tile (clipped to a polygon) and an
 * axis name eats the whole plot. This rewrites the geometry to be size-relative
 * so a chart fits whatever cell it lands in — the one place that has to know
 * ECharts' option shape, kept next to the assembly it corrects.
 */
function makeResponsive(option: Record<string, unknown>): void {
  const rawSeries = option["series"];
  const series = (
    Array.isArray(rawSeries) ? rawSeries : rawSeries ? [rawSeries] : []
  ) as Record<string, unknown>[];

  const hasPie = series.some((s) => s && s["type"] === "pie");

  if (hasPie) {
    for (const s of series) {
      if (s["type"] !== "pie") continue;
      // Percentage radius/center resolve against the live box, so the pie
      // always fits and re-centers on resize (see EChart's ResizeObserver).
      s["radius"] = ["0%", "60%"];
      s["center"] = ["50%", "50%"];
      s["avoidLabelOverlap"] = true;
      s["labelLayout"] = { hideOverlap: true };
      // Tiny slivers (sub-2°) would just stack unreadable leader lines.
      s["minShowLabelAngle"] = 2;
      const label = (s["label"] as Record<string, unknown>) ?? {};
      s["label"] = { ...label, fontSize: 11, overflow: "truncate", width: 84 };
      s["labelLine"] = { length: 8, length2: 6 };
    }
    // A pie has no cartesian grid; nothing else to correct.
    return;
  }

  // Cartesian: let ECharts reserve exactly the room the labels need
  // (containLabel) instead of flint's fixed margins, and drop the raw
  // field-name axis titles — the card header already names the chart.
  option["grid"] = {
    left: 14,
    right: 18,
    top: 30,
    bottom: 12,
    containLabel: true,
  };

  for (const key of ["xAxis", "yAxis"] as const) {
    const raw = option[key];
    const axes = (
      Array.isArray(raw) ? raw : raw ? [raw] : []
    ) as Record<string, unknown>[];
    for (const axis of axes) {
      delete axis["name"];
      delete axis["nameGap"];
      const axisLabel = (axis["axisLabel"] as Record<string, unknown>) ?? {};
      // hideOverlap thins colliding ticks instead of letting them smear
      // together; flint's forced 90° rotation is dropped for level labels.
      axis["axisLabel"] = {
        ...axisLabel,
        hideOverlap: true,
        rotate: 0,
        fontSize: 10,
      };
      if (axis["type"] === "value" || axis["type"] === "log") {
        (axis["axisLabel"] as Record<string, unknown>)["formatter"] = (
          v: number,
        ) => compactNumber(v);
      }
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringRecord(v: unknown): Record<string, string> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" && val !== "") out[k] = val;
  }
  return out;
}

/** Narrow an unknown tool arg to a ChartSpec, or null if it isn't one. */
export function asChartSpec(value: unknown): ChartSpec | null {
  if (!isRecord(value)) return null;
  const { chartType, title, data } = value;
  if (typeof chartType !== "string" || chartType === "") return null;
  const encodings = stringRecord(value["encodings"]);
  if (!encodings || Object.keys(encodings).length === 0) return null;
  if (!Array.isArray(data)) return null;
  return {
    chartType,
    title: typeof title === "string" ? title : "",
    encodings,
    data: data.filter(isRecord),
    horizontal: value["horizontal"] === true,
    semanticTypes: stringRecord(value["semanticTypes"]) ?? undefined,
  };
}

/** Does this value read as a number? ClickHouse returns counts as strings. */
function isNumericValue(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") {
    const t = v.trim();
    return t !== "" && Number.isFinite(Number(t));
  }
  return false;
}

/** True when a column reads as numeric in the first row that has a value. */
function isNumericColumn(rows: Record<string, unknown>[], column: string): boolean {
  for (const row of rows) {
    const raw = row[column];
    if (raw === null || raw === undefined || raw === "") continue;
    return isNumericValue(raw);
  }
  return false;
}

/**
 * Infer a flint spec for a tile created without one (the manual "Add tile"
 * flow). The category (non-numeric) column is the x, the first number that
 * isn't x is the y, and the x's type picks the family: a non-numeric x is a set
 * of categories → bars, a numeric/date-ish x is a progression → a line. Returns
 * null when there is no usable x/y pair.
 */
export function inferChartSpec(
  rows: Record<string, unknown>[],
  title: string,
): ChartSpec | null {
  const first = rows[0];
  if (!first) return null;
  const columns = Object.keys(first);
  if (columns.length === 0) return null;

  const numeric = new Set(columns.filter((c) => isNumericColumn(rows, c)));

  const x = columns.find((c) => !numeric.has(c)) ?? columns[0];
  if (!x) return null;
  const y = columns.find((c) => c !== x && numeric.has(c));
  if (!y) return null;

  return {
    chartType: numeric.has(x) ? "Line Chart" : "Bar Chart",
    title,
    encodings: { x, y },
    data: rows,
  };
}

/**
 * How wide a chart wants to be in a multi-chart grid: 2 = a full row, 1 = half.
 *
 * The component owns this, not the agent — the agent only says what the chart IS
 * (type + data), and the layout follows from that. A progression reads along a
 * horizontal axis and needs the room; a part-to-whole reads fine small; a
 * category chart earns a full row only once it has enough bars to be cramped.
 */
export function chartSpan(spec: ChartSpec): 1 | 2 {
  const t = spec.chartType.toLowerCase();
  const n = spec.data.length;

  // Parts-to-whole, gauges and radials read well small.
  if (/pie|donut|doughnut|rose|funnel|gauge|radar|waffle|nightingale/.test(t)) {
    return 1;
  }
  // Trends need horizontal room for the progression.
  if (/line|area|step/.test(t)) return 2;
  // Flows, matrices and relationship grids want width.
  if (/sankey|heatmap|matrix|chord|graph|tree|parallel|calendar/.test(t)) {
    return 2;
  }
  // Bar / column / histogram / lollipop / scatter: a full row only once there
  // are enough marks that half-width would crowd them.
  return n > 8 ? 2 : 1;
}

/** Compile a spec to an ECharts option, or null if flint can't (bad fields, etc.). */
export function optionFromSpec(spec: ChartSpec): EChartsCoreOption | null {
  if (spec.data.length === 0) return null;

  // flint wants each channel as { field: "name" }.
  const encodings: Record<string, { field: string }> = {};
  for (const [channel, field] of Object.entries(spec.encodings)) {
    encodings[channel] = { field };
  }

  let option: Record<string, unknown>;
  try {
    option = assembleECharts({
      data: { values: spec.data },
      ...(spec.semanticTypes ? { semantic_types: spec.semanticTypes } : {}),
      chart_spec: {
        chartType: spec.chartType,
        encodings,
        baseSize: { width: 720, height: 320 },
      },
    }) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Long category labels: flip a bar onto its side so labels stay level. ECharts
  // reads bar orientation from which axis is the category, so swapping the two
  // axis definitions is the whole change.
  if (spec.horizontal && FLIPPABLE.has(spec.chartType)) {
    const { xAxis, yAxis } = option;
    option["xAxis"] = yAxis;
    option["yAxis"] = xAxis;
  }

  // Rewrite flint's fixed-pixel geometry to size-relative so the chart fits and
  // stays readable in whatever cell it lands in.
  makeResponsive(option);

  // flint leaves a single series unnamed, so ECharts labels it "series0" in the
  // tooltip. Name it after the measure the chart plots — the tooltip then reads
  // "revenue: 6M" instead. Multi-series charts already carry their group names.
  const measure =
    spec.encodings["y"] ??
    spec.encodings["value"] ??
    spec.encodings["size"] ??
    spec.encodings["angle"] ??
    Object.values(spec.encodings).at(-1);
  const seriesList = Array.isArray(option["series"])
    ? (option["series"] as Record<string, unknown>[])
    : option["series"]
      ? [option["series"] as Record<string, unknown>]
      : [];
  if (measure && seriesList.length === 1 && seriesList[0]!["name"] == null) {
    seriesList[0]!["name"] = measure;
  }

  // The Card header already shows the title, so strip any title flint set —
  // otherwise it double-prints, oversized, over the plot.
  delete option["title"];

  return option as EChartsCoreOption;
}

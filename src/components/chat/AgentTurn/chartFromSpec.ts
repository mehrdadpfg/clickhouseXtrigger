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

  // The Card header already shows the title, so strip any title flint set —
  // otherwise it double-prints, oversized, over the plot.
  delete option["title"];

  return option as EChartsCoreOption;
}

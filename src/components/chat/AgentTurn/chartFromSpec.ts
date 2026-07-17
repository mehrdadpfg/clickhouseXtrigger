import { assembleECharts } from "flint-chart";
import type { EChartsCoreOption } from "echarts";

/**
 * Maps the agent's `renderChart` tool spec onto flint-chart, which compiles it
 * to an ECharts option. This is the one place that knows the tool contract, so
 * it lives with the chat turn, not in the pure EChart primitive.
 *
 * The spec shape mirrors the zod schema on the `renderChart` tool in
 * src/trigger/chat.ts — keep the two in sync.
 */
export interface ChartSpec {
  kind: "line" | "bar" | "barH" | "scatter" | "area";
  title: string;
  x: { field: string; label?: string };
  y: { field: string; label?: string };
  series?: { field: string };
  data: Record<string, unknown>[];
}

/** Our kinds → flint template names. barH is a bar we flip after assembly. */
const CHART_TYPE: Record<ChartSpec["kind"], string> = {
  line: "Line Chart",
  area: "Area Chart",
  bar: "Bar Chart",
  barH: "Bar Chart",
  scatter: "Scatter Plot",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Narrow an unknown tool arg to a ChartSpec, or null if it isn't one. */
export function asChartSpec(value: unknown): ChartSpec | null {
  if (!isRecord(value)) return null;
  const { kind, title, x, y, data } = value;
  if (typeof kind !== "string" || !(kind in CHART_TYPE)) return null;
  if (!isRecord(x) || typeof x["field"] !== "string") return null;
  if (!isRecord(y) || typeof y["field"] !== "string") return null;
  if (!Array.isArray(data)) return null;
  return {
    kind: kind as ChartSpec["kind"],
    title: typeof title === "string" ? title : "",
    x: { field: x["field"], label: typeof x["label"] === "string" ? x["label"] : undefined },
    y: { field: y["field"], label: typeof y["label"] === "string" ? y["label"] : undefined },
    series: isRecord(value["series"]) && typeof value["series"]["field"] === "string"
      ? { field: value["series"]["field"] }
      : undefined,
    data: data.filter(isRecord),
  };
}

/** Compile a spec to an ECharts option, or null if flint can't (bad fields, etc.). */
export function optionFromSpec(spec: ChartSpec): EChartsCoreOption | null {
  if (spec.data.length === 0) return null;

  const encodings: Record<string, { field: string }> = {
    x: { field: spec.x.field },
    y: { field: spec.y.field },
  };
  if (spec.series) encodings["color"] = { field: spec.series.field };

  let option: Record<string, unknown>;
  try {
    option = assembleECharts({
      data: { values: spec.data },
      chart_spec: {
        chartType: CHART_TYPE[spec.kind],
        encodings,
        baseSize: { width: 560, height: 240 },
      },
    }) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Long category labels: flip a bar onto its side so labels stay level. ECharts
  // reads bar orientation from which axis is the category, so swapping the two
  // axis definitions is the whole change.
  if (spec.kind === "barH") {
    const { xAxis, yAxis } = option;
    option["xAxis"] = yAxis;
    option["yAxis"] = xAxis;
  }

  if (spec.title) {
    option["title"] = { text: spec.title, left: 0, top: 0 };
    option["grid"] = { ...(isRecord(option["grid"]) ? option["grid"] : {}), top: 34 };
  }

  return option as EChartsCoreOption;
}

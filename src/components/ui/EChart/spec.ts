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
  /**
   * The queryClickhouse SQL that produced `data`. The workspace shows it under
   * the chart, and it is what lets a selection on the chart be turned back into
   * a query over the same grain.
   */
  sql?: string;
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

/** A funnel/legend name that is itself a big number reads better compacted. */
function compactLabelText(name: unknown): string {
  const s = String(name);
  const num = Number(s);
  return s.trim() !== "" && Number.isFinite(num) ? compactNumber(num) : s;
}

type SankeyLink = { source: string; target: string; value?: unknown };

/** Does a directed edge list contain a cycle? DFS with a recursion stack. */
function linksHaveCycle(links: SankeyLink[]): boolean {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const { source, target } of links) {
    nodes.add(source);
    nodes.add(target);
    (adj.get(source) ?? adj.set(source, []).get(source)!).push(target);
  }
  const GRAY = 1;
  const BLACK = 2;
  const state = new Map<string, number>();
  const visit = (u: string): boolean => {
    state.set(u, GRAY);
    for (const v of adj.get(u) ?? []) {
      const s = state.get(v);
      if (s === GRAY) return true; // back-edge → cycle
      if (s === undefined && visit(v)) return true;
    }
    state.set(u, BLACK);
    return false;
  };
  for (const n of nodes) {
    if (state.get(n) === undefined && visit(n)) return true;
  }
  return false;
}

/**
 * ECharts' Sankey must be a DAG, but flow data over one set of categories
 * (pickup → dropoff neighborhood) routinely cycles: A→B and B→A both exist, or a
 * self-loop A→A. That throws "Sankey is a DAG, the original data has cycle!" and
 * kills the chart. When the links cycle, bipartite-ize: give every TARGET node a
 * zero-width-space suffix so a name that is both a source and a target becomes
 * two distinct nodes. The graph is then strictly source-layer → target-layer —
 * always acyclic — and the suffix is invisible, so the labels read unchanged.
 * A genuinely acyclic (possibly multi-hop) Sankey is left untouched.
 */
function decycleSankey(series: Record<string, unknown>): void {
  const rawLinks = Array.isArray(series["links"]) ? series["links"] : [];
  const links: SankeyLink[] = (rawLinks as Record<string, unknown>[]).map((l) => ({
    source: String(l["source"]),
    target: String(l["target"]),
    value: l["value"],
  }));
  if (links.length === 0 || !linksHaveCycle(links)) return;

  const ZW = "​"; // zero-width space: distinct string, invisible label
  const nodes = Array.isArray(series["data"]) ? (series["data"] as Record<string, unknown>[]) : [];
  const styleByName = new Map<string, unknown>();
  for (const n of nodes) styleByName.set(String(n["name"]), n["itemStyle"]);

  const newLinks: Record<string, unknown>[] = (rawLinks as Record<string, unknown>[]).map(
    (l) => ({ ...l, target: String(l["target"]) + ZW }),
  );

  const sources = new Set(newLinks.map((l) => String(l["source"])));
  const targets = new Set(newLinks.map((l) => String(l["target"])));
  const build = (name: string, styleKey: string) => {
    const itemStyle = styleByName.get(styleKey);
    return itemStyle ? { name, itemStyle } : { name };
  };
  series["data"] = [
    ...[...sources].map((name) => build(name, name)),
    ...[...targets].map((name) => build(name, name.slice(0, -1))),
  ];
  series["links"] = newLinks;

  // The suffix is invisible, but strip it from the label anyway so a copied
  // label or a screen reader reads the clean name.
  const label = (series["label"] as Record<string, unknown>) ?? {};
  series["label"] = {
    ...label,
    formatter: (p: { name?: unknown }) => String(p?.name ?? "").replace(/​/g, ""),
  };
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
      // Percentage radius/center resolve against the live box, so the pie always
      // fits and re-centers on resize (see EChart's ResizeObserver). Centred a
      // little high to leave the bottom strip for the legend.
      s["radius"] = ["0%", "62%"];
      s["center"] = ["50%", "44%"];
      s["avoidLabelOverlap"] = true;
      // Labels go INSIDE the slices as a bare percentage, and the legend below
      // carries the category names. Outside leader-line labels clip against a
      // small tile's edges and collide; this always fits. Slices too thin to
      // hold a number (under ~14°) drop their label — the legend still names them.
      // Dark ink: the series fills are light pastels, so an inside label must be
      // near-black to read — white-on-pastel was the unreadable case. (A concrete
      // colour, not a token: ECharts paints to canvas and can't resolve var().)
      s["label"] = {
        show: true,
        position: "inside",
        formatter: "{d}%",
        color: "#0a0a0a",
        fontSize: 11,
        fontWeight: 600,
        textBorderColor: "transparent",
      };
      s["labelLine"] = { show: false };
      s["minShowLabelAngle"] = 14;
    }
    // The legend names every slice — the piece the inside labels leave out.
    option["legend"] = {
      type: "scroll",
      bottom: 2,
      left: "center",
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 12,
      textStyle: { fontSize: 11 },
    };
    // A pie has no cartesian grid; nothing else to correct.
    return;
  }

  // Funnel/pyramid: flint leaves raw values as slice labels (a 9-digit integer
  // per band) and drops a default legend on the right that overlaps the widest
  // slices. Same treatment as the pie — compact labels INSIDE the slices, one
  // scrolling legend along the bottom — so a revenue funnel reads instead of
  // printing "262127273" across every band.
  const hasFunnel = series.some((s) => s && s["type"] === "funnel");
  if (hasFunnel) {
    for (const s of series) {
      if (s["type"] !== "funnel") continue;
      // Leave a bottom strip for the legend and side gutters so the widest band
      // doesn't run to the card edge; a hair of gap separates the bands.
      s["left"] = "8%";
      s["right"] = "8%";
      s["top"] = 10;
      s["bottom"] = 34;
      s["gap"] = 2;
      s["label"] = {
        show: true,
        position: "inside",
        color: "#0a0a0a",
        fontSize: 11,
        fontWeight: 600,
        textBorderColor: "transparent",
        formatter: (p: { name?: unknown }) => compactLabelText(p?.name),
      };
      s["labelLine"] = { show: false };
    }
    option["legend"] = {
      type: "scroll",
      bottom: 2,
      left: "center",
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 12,
      textStyle: { fontSize: 11 },
      formatter: (name: unknown) => compactLabelText(name),
    };
    return;
  }

  // Treemap / sunburst: flint paints the tile labels white, which is unreadable
  // on the light pastel fills, and shows a white breadcrumb bar (the "columns"
  // box) that clashes with the dark card. Dark ink on the fills (same call as the
  // pie), drop the breadcrumb, and darken the tile gaps so they read as seams on
  // the card rather than white grid lines.
  const hasTreemap = series.some(
    (s) => s && (s["type"] === "treemap" || s["type"] === "sunburst"),
  );
  if (hasTreemap) {
    for (const s of series) {
      const type = s["type"];
      if (type !== "treemap" && type !== "sunburst") continue;
      const label = (s["label"] as Record<string, unknown>) ?? {};
      s["label"] = { ...label, show: true, color: "#0a0a0a", fontSize: 12 };
      if (type === "treemap") {
        const upper = (s["upperLabel"] as Record<string, unknown>) ?? {};
        s["upperLabel"] = { ...upper, color: "#0a0a0a" };
        s["breadcrumb"] = { show: false };
        const itemStyle = (s["itemStyle"] as Record<string, unknown>) ?? {};
        s["itemStyle"] = {
          ...itemStyle,
          borderColor: "#0a0a0a",
          borderWidth: 1,
          gapWidth: 1,
        };
      }
    }
    return;
  }

  // Sankey: a DAG in ECharts, but flow-between-same-categories data cycles and
  // throws. Break any cycle by bipartite-izing (see decycleSankey). No cartesian
  // grid or zoom applies, so handle it here and return.
  const hasSankey = series.some((s) => s && s["type"] === "sankey");
  if (hasSankey) {
    for (const s of series) {
      if (s["type"] !== "sankey") continue;
      decycleSankey(s);
      // Keep every node label INSIDE the plot: source (left-layer) labels point
      // right, sink (right-layer) labels point left. ECharts' default 'right' for
      // all nodes runs the rightmost labels off the card's edge (clipped and
      // unreadable). White ink with a dark outline reads over the flow ribbons.
      const links = Array.isArray(s["links"])
        ? (s["links"] as Record<string, unknown>[])
        : [];
      const sources = new Set(links.map((l) => String(l["source"])));
      const targets = new Set(links.map((l) => String(l["target"])));
      const nodes = Array.isArray(s["data"])
        ? (s["data"] as Record<string, unknown>[])
        : [];
      for (const n of nodes) {
        const name = String(n["name"]);
        const sink = targets.has(name) && !sources.has(name);
        n["label"] = { position: sink ? "left" : "right" };
      }
      s["left"] = "4%";
      s["right"] = "4%";
      s["top"] = 12;
      s["bottom"] = 12;
      const label = (s["label"] as Record<string, unknown>) ?? {};
      s["label"] = {
        ...label,
        fontSize: 11,
        color: "#ffffff",
        textBorderColor: "rgba(0,0,0,0.85)",
        textBorderWidth: 3,
      };
    }
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
      // A long category label (a neighborhood name) is centred under its bar and
      // spills past the plot edge — the first one runs left under the y-axis and
      // clips to "Jtown-…". Cap the label width and ellipsize so it stays under
      // its own bar; the full name is still in the hover tooltip.
      if (axis["type"] === "category") {
        (axis["axisLabel"] as Record<string, unknown>)["width"] = 76;
        (axis["axisLabel"] as Record<string, unknown>)["overflow"] = "truncate";
        (axis["axisLabel"] as Record<string, unknown>)["ellipsis"] = "…";
      }
      if (axis["type"] === "value" || axis["type"] === "log") {
        (axis["axisLabel"] as Record<string, unknown>)["formatter"] = (
          v: number,
        ) => compactNumber(v);
      }
      // flint bakes a padded numeric min onto value axes (e.g. min:-57000 under a
      // scatter whose data starts at 0), which drops the origin off-screen and
      // misaligns the plot. Replace it with the data-relative rule: pin to 0 when
      // the data is all ≥ 0, otherwise hand back to ECharts (null → auto "nice").
      // Overrides flint's value unconditionally — its padding is the bug. Log
      // axes can't hold 0, so skip them.
      if (axis["type"] === "value") {
        axis["min"] = (v: { min: number }) => (v.min >= 0 ? 0 : null);
      }
    }
  }

  // Zoom + pan. `inside` keeps the plot chrome-free (no slider bar eating a
  // small tile), and Shift-gates the wheel so scrolling the reading column over
  // a chart still scrolls the page instead of zooming it — plain drag pans, a
  // double-click resets. A scatter zooms on both axes; everything else on x.
  const hasScatter = series.some((s) => s && s["type"] === "scatter");
  const zoom = (axis: "xAxisIndex" | "yAxisIndex") => ({
    type: "inside" as const,
    [axis]: 0,
    zoomOnMouseWheel: "shift" as const,
    moveOnMouseWheel: false,
    moveOnMouseMove: true,
  });
  option["dataZoom"] = hasScatter
    ? [zoom("xAxisIndex"), zoom("yAxisIndex")]
    : [zoom("xAxisIndex")];

  // Multi-series cartesian: a legend the reader can click to isolate a series.
  // ALWAYS reposition it to one scrolling row along the top — flint puts a grouped
  // chart's legend VERTICAL on the right (right:10), which sits ON TOP of the plot
  // and reads as a second chart overlapping. Override it (whether flint set one or
  // not) and drop the grid down to make room.
  if (series.length > 1) {
    option["legend"] = {
      type: "scroll",
      top: 2,
      left: "center",
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 12,
      textStyle: { fontSize: 11 },
    };
    (option["grid"] as Record<string, unknown>)["top"] = 34;
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

  // Line is for a *progression* — a numeric/temporal x with enough points to
  // read as a trend. A numeric x with only a handful of values (passenger_count
  // 0–9, a rating 1–5) is a set of categories, not a curve, so it stays a bar.
  // A non-numeric x is always categorical.
  const isProgression = numeric.has(x) && rows.length > 12;

  return {
    chartType: isProgression ? "Line Chart" : "Bar Chart",
    title,
    encodings: { x, y },
    data: rows,
  };
}

/** Part-to-whole families read a category + a value, not an x/y pair. */
const PART_TO_WHOLE =
  /pie|donut|doughnut|rose|nightingale|funnel|pyramid|treemap|sunburst|waffle/i;

/**
 * Build a chart spec for a result, honouring an agent-chosen `chartType` even
 * when it didn't map the encodings.
 *
 * The agent picks the chart's JOB (pie, scatter, bar…) but often leaves
 * `encodings` empty. Dropping to a plain inference then throws that choice away
 * and every chart collapses to a bar or a line. So when a type is named but
 * unmapped, we infer the x/y from the result shape and slot them into the
 * channels that type actually reads — a part-to-whole gets {category, value}, a
 * relationship gets {x, y}. Only a truly typeless result falls back to inference.
 */
export function resolveChartSpec(
  rows: Record<string, unknown>[],
  title: string,
  chartType?: string,
  encodings?: Record<string, string>,
): ChartSpec | null {
  const enc =
    encodings && Object.keys(encodings).length > 0 ? encodings : null;

  // The agent fully specified the chart — use it as-is.
  if (chartType && enc) {
    return { chartType, title, encodings: enc, data: rows };
  }

  const inferred = inferChartSpec(rows, title);
  if (!inferred) return null;

  // No type named: the inferred bar/line is the best we can do.
  if (!chartType) return inferred;

  // Type named but unmapped: keep the agent's type, remap the inferred x/y into
  // the channels that type actually reads. Most part-to-whole families take
  // {color=category, size=measure}, but flint's funnel keys its category off `y`
  // (FAMILY_FUNNEL: y=category, size=measure) — mapping it to `color` leaves it
  // with no category and it never compiles. A relationship keeps plain {x, y}.
  const { x, y } = inferred.encodings as { x: string; y: string };
  let remapped: Record<string, string>;
  if (/funnel/i.test(chartType)) {
    remapped = { y: x, size: y };
  } else if (PART_TO_WHOLE.test(chartType)) {
    remapped = { color: x, size: y };
  } else {
    remapped = { x, y };
  }
  return { chartType, title, encodings: remapped, data: rows };
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
  if (/pie|donut|doughnut|rose|funnel|pyramid|gauge|radar|waffle|nightingale/.test(t)) {
    return 1;
  }
  // Trends need horizontal room for the progression.
  if (/line|area|step/.test(t)) return 2;
  // Flows, matrices and relationship grids want width.
  if (/sankey|heatmap|matrix|chord|graph|tree|parallel|calendar/.test(t)) {
    return 2;
  }
  // A horizontal bar gets TALLER with more categories, not wider, so it pairs
  // half-width like any category chart. Only a genuinely long list claims a full
  // row — past this many bars, the extra width keeps the truncated labels legible
  // rather than stranding the tile next to it and leaving the row half empty.
  if (spec.horizontal && n > 16) return 2;
  // Everything else — vertical bars, histograms, lollipops, scatter — reads at
  // half width, so two tiles pair into a row instead of each claiming its own.
  // A dense vertical bar is a touch tighter half-width, but packing the
  // dashboard into fewer rows is the better trade than stranding a half-empty row.
  return 1;
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

  // flint bakes its OWN default palette onto the option (option.color) and pins
  // a single fill on each series' itemStyle — both of which override the app's
  // onyx --series palette set on the ECharts theme. Drop option.color so the
  // brand palette drives every chart instead of flint's ECharts-default blues.
  delete option["color"];

  // Colour diversity for a single-series categorical chart. By default flint
  // paints every bar the one pinned colour — the "everything is blue" complaint.
  // Removing that pin and setting colorBy:"data" spreads the palette across the
  // categories, so a ranking or a distribution reads with distinct hues.
  // Deliberately NOT applied to a line/area (one entity, one colour) or a scatter
  // (a cloud of one population) — only the bar family, where each mark IS a
  // category.
  if (seriesList.length === 1) {
    const type = seriesList[0]!["type"];
    if (type === "bar" || type === "pictorialBar") {
      seriesList[0]!["colorBy"] = "data";
      const itemStyle = seriesList[0]!["itemStyle"];
      if (itemStyle && typeof itemStyle === "object") {
        delete (itemStyle as Record<string, unknown>)["color"];
      }
    }
  }

  // Hover focus: highlight what the pointer is on and dim the rest, so a dense
  // multi-line chart or a many-slice pie reads one series at a time. A pie/funnel
  // focuses the single slice ("self"); a cartesian chart focuses the whole series
  // ("series"). Left off scatter — one cloud of one population, nothing to isolate.
  for (const s of seriesList) {
    const type = s["type"];
    if (type === "scatter") continue;
    const focus = type === "pie" || type === "funnel" ? "self" : "series";
    const emphasis = (s["emphasis"] as Record<string, unknown>) ?? {};
    s["emphasis"] = { ...emphasis, focus };
  }

  // The Card header already shows the title, so strip any title flint set —
  // otherwise it double-prints, oversized, over the plot.
  delete option["title"];

  return option as EChartsCoreOption;
}

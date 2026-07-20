"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuiState, useThreadRuntime } from "@assistant-ui/react";
import {
  AreaChart,
  BarChart3,
  Expand,
  Eye,
  LineChart,
  PieChart,
  Table as TableIcon,
} from "lucide-react";
import type { ChartSpec } from "@/components/ui";
import type {
  DataColumn,
  DataRow,
  EChartHandle,
  StatDelta,
  StatDirection,
} from "@/components/ui";
import {
  asChartSpec,
  Card,
  chartSpan,
  DataTable,
  EChart,
  ExportMenu,
  optionFromSpec,
  slugify,
  SqlBlock,
  StatTile,
} from "@/components/ui";
import { ChartTypeMenu, recast, TABLE_VIEW } from "../ChartType";
import { useChatPrefs } from "../ChatPrefs";
import { markUiAction } from "../uiAction";
import { useWorkspace } from "../ChartWorkspace";
import {
  ChoiceCard,
  readChoices,
  readThreshold,
  readWatcher,
  ThresholdCard,
  WatcherCard,
} from "./GenerativeParts";
import {
  ASK_THRESHOLD,
  CREATE_WATCHER,
  DELETE_WATCHER,
  EDIT_WATCHER,
  PRESENT_CHOICES,
  QUERY_CLICKHOUSE,
  RENDER_CHART,
  RENDER_STAT,
} from "./steps";
import styles from "./AgentTurn.module.css";

/**
 * What the agent got back, rendered as artifacts under the answer.
 *
 * Every shape decision is made from the *result*, never a table name: the
 * columns are whatever keys the rows came with, so a taxi table and a pod table
 * render identically.
 *
 * When the agent draws a chart, that chart is the view of the data — so the raw
 * query table is suppressed (it would otherwise print the same numbers twice,
 * once as a table and once as a chart). The SQL stays as the collapsed receipt.
 */

/** Rows past this are a scroll, not a read — the table says so in its footer. */
const MAX_ROWS = 50;

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const COUNT = new Intl.NumberFormat("en-US");

/**
 * A headline number that fits its tile. A KPI is read at a glance, not audited,
 * so a nine-figure revenue compacts to "324.66M" rather than overflowing the
 * card with "324,657,107.943". Below a million it keeps full digits + separators
 * (20,000,000 reads fine and fits); the fractional part is dropped there too so a
 * long decimal tail can't spill either.
 */
function compactStat(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  return NUMBER.format(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** queryClickhouse resolves the JSONEachRow body — an array of row objects. */
function toRows(result: unknown): DataRow[] {
  if (!Array.isArray(result)) return [];
  return result.filter(isRecord);
}

/**
 * ClickHouse hands back 64-bit integers as strings in the JSON formats, because
 * they don't survive a JS number. For display that distinction doesn't matter,
 * so a numeric string counts as a number here — but only when it round-trips, so
 * an id-like string is never silently reformatted with thousands separators.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && String(parsed) === value.trim()
    ? parsed
    : null;
}

/**
 * One row, one column, one number — an answer that *is* a figure, so it reads as
 * one rather than a 1x1 table. Anything else falls through.
 */
function singleStat(rows: DataRow[]): { label: string; value: string } | null {
  if (rows.length !== 1) return null;
  const entries = Object.entries(rows[0]!);
  if (entries.length !== 1) return null;
  const [label, raw] = entries[0]!;
  const value = asNumber(raw);
  return value === null ? null : { label, value: compactStat(value) };
}

/**
 * A renderStat tool-call, read defensively off its args.
 *
 * The tool echoes its input, so the spec is on `args` whether or not the result
 * streamed. `value` must be a real number for the tile to mean anything — a
 * missing or non-numeric value drops the whole stat rather than rendering "NaN".
 */
interface StatSpec {
  label: string;
  value: number;
  unit?: string;
  delta?: number;
  deltaLabel?: string;
  upIsGood?: boolean;
}

function readStat(args: unknown): StatSpec | null {
  if (!isRecord(args)) return null;
  const label = typeof args["label"] === "string" ? args["label"].trim() : "";
  const value = asNumber(args["value"]);
  if (label === "" || value === null) return null;

  const spec: StatSpec = { label, value };
  const unit = args["unit"];
  if (unit === "$" || unit === "%" || unit === "×") spec.unit = unit;
  const delta = asNumber(args["delta"]);
  if (delta !== null) spec.delta = delta;
  if (typeof args["deltaLabel"] === "string" && args["deltaLabel"].trim() !== "")
    spec.deltaLabel = args["deltaLabel"].trim();
  if (typeof args["upIsGood"] === "boolean") spec.upIsGood = args["upIsGood"];
  return spec;
}

/**
 * The number as it reads on the tile: '$' leads, '%' and '×' trail (handed to
 * StatTile as its unit so it rides the baseline), a plain number stands alone.
 */
function formatStatValue(value: number, unit?: string): {
  value: string;
  unit?: string;
} {
  // Percent / multiplier are small by nature — keep them exact. Money and plain
  // numbers can be huge, so they compact to fit the tile.
  if (unit === "%" || unit === "×") return { value: NUMBER.format(value), unit };
  if (unit === "$") return { value: `$${compactStat(value)}` };
  return { value: compactStat(value) };
}

function directionOf(value: number): StatDirection {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

/** A single headline number the agent asked to show as a KPI tile. */
function StatArtifact({ spec }: { spec: StatSpec }) {
  const { value, unit } = formatStatValue(spec.value, spec.unit);

  let delta: StatDelta | undefined;
  if (spec.delta !== undefined) {
    const direction = directionOf(spec.delta);
    // Sentiment splits from direction: a rise is good news only when the metric
    // says so (revenue up vs latency up). Flat is neutral; upIsGood defaults on.
    const upIsGood = spec.upIsGood ?? true;
    const sentiment =
      direction === "flat"
        ? "neutral"
        : (direction === "up") === upIsGood
          ? "good"
          : "bad";
    delta = {
      value: `${Math.abs(spec.delta).toFixed(1)}%`,
      direction,
      sentiment,
      ...(spec.deltaLabel ? { note: spec.deltaLabel } : {}),
    };
  }

  return (
    <Card padding="sm">
      <StatTile
        size="md"
        label={spec.label}
        value={value}
        {...(unit ? { unit } : {})}
        {...(delta ? { delta } : {})}
      />
    </Card>
  );
}

function toColumns(rows: DataRow[]): DataColumn[] {
  // Row 0 defines the shape: a SELECT's projection is fixed, so every row has
  // the same keys in the same order.
  return Object.keys(rows[0] ?? {}).map((key) => ({ key, label: key }));
}

/**
 * Artifacts of one completed queryClickhouse call. When a chart is present the
 * table is hidden — the chart is the view — but a single-figure stat and the SQL
 * receipt always show.
 */
function QueryArtifact({
  sql,
  result,
  hideTable,
  hideStat,
}: {
  sql?: string;
  result: unknown;
  hideTable: boolean;
  /** An explicit renderStat covers this number — don't also infer a stat card. */
  hideStat: boolean;
}) {
  const rows = toRows(result);
  const stat = hideStat ? null : singleStat(rows);
  const shown = rows.slice(0, MAX_ROWS);
  // The SQL is the agent's "work"; verbose-off hides it (like the work card),
  // leaving the answer's tables/charts/stats.
  const { verbose } = useChatPrefs();

  return (
    <>
      {stat ? (
        <Card>
          <StatTile label={stat.label} value={stat.value} />
        </Card>
      ) : !hideTable && rows.length > 0 && !singleStat(rows) ? (
        <Card padding="none" clip>
          <DataTable
            columns={toColumns(rows)}
            rows={shown}
            maxHeight="320px"
            footer={
              <span>
                {rows.length > shown.length
                  ? `${COUNT.format(shown.length)} of ${COUNT.format(rows.length)} rows`
                  : `${COUNT.format(rows.length)} row${rows.length === 1 ? "" : "s"}`}
              </span>
            }
          />
        </Card>
      ) : null}

      {/* The query is the receipt for the numbers — collapsed but never absent,
          unless the reader has turned the agent's work off. */}
      {sql && verbose ? (
        <SqlBlock
          sql={sql}
          summary={`SQL — ${COUNT.format(rows.length)} row${rows.length === 1 ? "" : "s"}`}
        />
      ) : null}
    </>
  );
}

/**
 * A chart the agent asked for — chart only. Falls back to the data if flint
 * can't compile it.
 *
 * `inGrid` is set when it sits in the multi-chart grid. There the component
 * picks the chart's footprint from its type + data (chartSpan): a trend or a
 * dense category chart takes a full row; a part-to-whole or a small chart takes
 * a half. A lone chart isn't gridded — it keeps the full measure.
 */
function ChartArtifact({
  spec: raw,
  chartId,
  inGrid,
}: {
  spec: unknown;
  /** This chart's tool-call id — the workspace's identity for it. */
  chartId: string;
  inGrid: boolean;
}) {
  const spec = useMemo(() => asChartSpec(raw), [raw]);
  // "" = the agent's original type; otherwise the reader's pick (a chartType or
  // TABLE_VIEW). Recast client-side so switching never re-asks the agent.
  const [view, setView] = useState<string>("");
  const asTable = view === TABLE_VIEW;
  const displaySpec = useMemo(() => {
    if (!spec || asTable) return spec;
    const t = view || spec.chartType;
    return t === spec.chartType ? spec : recast(spec, t);
  }, [spec, view, asTable]);
  const option = useMemo(
    () => (displaySpec && !asTable ? optionFromSpec(displaySpec) : null),
    [displaySpec, asTable],
  );
  const chartRef = useRef<EChartHandle>(null);
  const thread = useThreadRuntime();
  const { open: openWorkspace } = useWorkspace();

  // The eye hands the chart back to the agent as a standing question. It sends
  // the title, not the chart's SQL: that query returns a column of rows, and a
  // watcher compares ONE number, so the metric has to be chosen before any SQL
  // exists. Asking rather than guessing is the point — the agent answers with
  // presentChoices, and the reader picks the number and the threshold there.
  const watch = () => {
    if (!spec) return;
    thread.append(
      markUiAction(
        "Watch",
        `Set up a watcher on "${spec.title}". Ask me which number from this chart to watch and what threshold should trip it before you create it.`,
      ),
    );
  };

  if (!spec) return null;

  const current = view || spec.chartType;
  const span = chartSpan(spec);
  // Full-row tiles get their own line, so they can be a touch taller; two
  // half tiles share a row and must match, so they share a height.
  const style = inGrid && span === 2 ? { gridColumn: "1 / -1" } : undefined;
  const height = inGrid ? (span === 2 ? 300 : 260) : 340;
  const rows = spec.data as DataRow[];
  // Table view, or a type the data can't compile to, falls back to the raw rows.
  const showTable = asTable || !option;

  return (
    <Card
      className={inGrid ? styles.chartTile : undefined}
      style={{ position: "relative", ...(style ?? {}) }}
    >
      {/* Per-chart tools: recast the type, open the chart in the workspace, put
          it under a watcher, download it. */}
      <div className={styles.chartTools}>
        <ChartTypeMenu
          current={showTable ? TABLE_VIEW : current}
          allowPie={rows.length <= 12}
          onPick={setView}
          triggerClassName={styles.chartTool}
        />
        <button
          type="button"
          className={styles.chartTool}
          onClick={() =>
            openWorkspace({ id: chartId, spec, view: showTable ? "" : current })
          }
          title="Open this chart"
          aria-label="Open this chart"
        >
          <Expand size={14} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.chartTool}
          onClick={watch}
          title="Watch this chart"
          aria-label="Watch this chart"
        >
          <Eye size={15} strokeWidth={2} aria-hidden="true" />
        </button>
        {!showTable ? (
          <ExportMenu
            chartRef={chartRef}
            filename={slugify(spec.title)}
            buttonClassName={styles.chartTool}
          />
        ) : null}
      </div>

      {spec.title ? (
        <div className={styles.chartHead}>
          <span className={styles.chartTitle}>{spec.title}</span>
        </div>
      ) : null}
      {showTable ? (
        <DataTable
          columns={toColumns(rows)}
          rows={rows.slice(0, MAX_ROWS)}
          maxHeight={`${height}px`}
        />
      ) : (
        <EChart ref={chartRef} option={option!} height={height} />
      )}
    </Card>
  );
}

/**
 * Held back until the message completes, and deliberately so. The parts stream
 * in tool-then-text order, so rendering results the moment they land would put a
 * table above the prose and then shove it down with every token. Mounting once,
 * at the end, is both the design's order and why the reading column doesn't jump
 * while text streams.
 */
export function Artifacts() {
  const parts = useAuiState((s) => s.message.parts);

  // A chart is the view of its data, so once the turn drew one, the raw query
  // tables are redundant — hide them and let the chart (plus the SQL receipt)
  // stand for the result.
  const chartCount = parts.filter(
    (part) =>
      part.type === "tool-call" &&
      part.toolName === RENDER_CHART &&
      part.status.type === "complete" &&
      !part.isError,
  ).length;
  const hasChart = chartCount > 0;
  // Two or more charts tile into a grid; a single chart keeps the full measure.
  const inGrid = chartCount > 1;

  // An explicit stat is the view of its number, so the inferred single-stat card
  // a query would otherwise draw is redundant — suppress it and let the richer
  // renderStat tile (with its label, unit and delta) stand for the figure.
  //
  // askThreshold suppresses it for a different reason: the agent runs the
  // metric's scalar SELECT purely to seed the form, and that one-row-one-column
  // result would otherwise surface as a headline KPI labelled with the column
  // alias ("c"). The form already prints the number as its live reading.
  const hasStat = parts.some(
    (part) =>
      part.type === "tool-call" &&
      (part.toolName === RENDER_STAT || part.toolName === ASK_THRESHOLD) &&
      part.status.type === "complete" &&
      !part.isError,
  );

  // Two bands: the query receipts (stat / table / SQL) stack, and every chart
  // the turn drew flows into one responsive grid. A single chart fills the row;
  // several tile across it — which is what lets one answer be a whole dashboard.
  const receipts: ReactNode[] = [];
  const stats: ReactNode[] = [];
  const charts: ReactNode[] = [];
  // Generative cards — the watcher-created confirmation and disambiguation
  // choices — lead the artifacts: they ARE the answer, not a supporting view.
  const generative: ReactNode[] = [];

  parts.forEach((part, i) => {
    if (
      part.type !== "tool-call" ||
      part.status.type !== "complete" ||
      part.isError
    ) {
      return;
    }

    if (part.toolName === QUERY_CLICKHOUSE) {
      const args = isRecord(part.args) ? part.args : {};
      const sql = typeof args["sql"] === "string" ? args["sql"] : undefined;
      receipts.push(
        <QueryArtifact
          key={part.toolCallId ?? i}
          sql={sql}
          result={part.result}
          hideTable={hasChart}
          hideStat={hasStat}
        />,
      );
      return;
    }

    if (part.toolName === RENDER_STAT) {
      // The tool echoes its input, so the spec is on args either way. Stats go in
      // their own band so several headline numbers tile into a KPI strip.
      const spec = readStat(part.args);
      if (spec) {
        stats.push(<StatArtifact key={part.toolCallId ?? i} spec={spec} />);
      }
      return;
    }

    if (
      part.toolName === CREATE_WATCHER ||
      part.toolName === EDIT_WATCHER ||
      part.toolName === DELETE_WATCHER
    ) {
      const view = readWatcher(part.args, part.result);
      if (view) {
        generative.push(<WatcherCard key={part.toolCallId ?? i} view={view} />);
      }
      return;
    }

    if (part.toolName === ASK_THRESHOLD) {
      const view = readThreshold(part.args);
      if (view) {
        generative.push(<ThresholdCard key={part.toolCallId ?? i} view={view} />);
      }
      return;
    }

    if (part.toolName === PRESENT_CHOICES) {
      const view = readChoices(part.args);
      if (view) {
        generative.push(<ChoiceCard key={part.toolCallId ?? i} view={view} />);
      }
      return;
    }

    if (part.toolName === RENDER_CHART) {
      // The tool echoes its input as output; args is the spec either way.
      charts.push(
        <ChartArtifact
          key={part.toolCallId ?? i}
          chartId={part.toolCallId ?? `chart-${i}`}
          spec={part.args}
          inGrid={inGrid}
        />,
      );
    }
  });

  if (
    receipts.length === 0 &&
    stats.length === 0 &&
    charts.length === 0 &&
    generative.length === 0
  ) {
    return null;
  }

  return (
    <div className={styles.artifacts}>
      {generative}
      {stats.length > 0 ? (
        <div className={styles.statGrid}>{stats}</div>
      ) : null}
      {receipts}
      {charts.length > 0 ? (
        <div className={inGrid ? styles.chartGrid : undefined}>{charts}</div>
      ) : null}
    </div>
  );
}

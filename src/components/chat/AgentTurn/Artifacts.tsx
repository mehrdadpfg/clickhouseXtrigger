"use client";

import { useMemo, type ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { DataColumn, DataRow } from "@/components/ui";
import {
  asChartSpec,
  Card,
  DataTable,
  EChart,
  optionFromSpec,
  SqlBlock,
  StatTile,
} from "@/components/ui";
import { QUERY_CLICKHOUSE, RENDER_CHART } from "./steps";
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
  return value === null ? null : { label, value: NUMBER.format(value) };
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
}: {
  sql?: string;
  result: unknown;
  hideTable: boolean;
}) {
  const rows = toRows(result);
  const stat = singleStat(rows);
  const shown = rows.slice(0, MAX_ROWS);

  return (
    <>
      {stat ? (
        <Card>
          <StatTile label={stat.label} value={stat.value} />
        </Card>
      ) : !hideTable && rows.length > 0 ? (
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

      {/* The query is the receipt for the numbers, so it ships with them —
          collapsed, but never absent. */}
      {sql ? (
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
 * can't compile it. `tile` is set when it sits in the multi-chart grid, where a
 * fixed height keeps the row even; a lone chart keeps its natural height.
 */
function ChartArtifact({ spec: raw, tile }: { spec: unknown; tile?: boolean }) {
  const spec = useMemo(() => asChartSpec(raw), [raw]);
  const option = useMemo(() => (spec ? optionFromSpec(spec) : null), [spec]);

  if (!spec) return null;

  if (!option) {
    const rows = spec.data as DataRow[];
    return (
      <Card padding="none" clip>
        <DataTable
          columns={toColumns(rows)}
          rows={rows.slice(0, MAX_ROWS)}
          maxHeight="320px"
        />
      </Card>
    );
  }

  return (
    <Card className={tile ? styles.chartTile : undefined}>
      {spec.title ? (
        <div className={styles.chartHead}>
          <span className={styles.chartTitle}>{spec.title}</span>
        </div>
      ) : null}
      <EChart option={option} {...(tile ? { height: 240 } : {})} />
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
  const multiChart = chartCount > 1;

  // Two bands: the query receipts (stat / table / SQL) stack, and every chart
  // the turn drew flows into one responsive grid. A single chart fills the row;
  // several tile across it — which is what lets one answer be a whole dashboard.
  const receipts: ReactNode[] = [];
  const charts: ReactNode[] = [];

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
        />,
      );
      return;
    }

    if (part.toolName === RENDER_CHART) {
      // The tool echoes its input as output; args is the spec either way.
      charts.push(
        <ChartArtifact
          key={part.toolCallId ?? i}
          spec={part.args}
          tile={multiChart}
        />,
      );
    }
  });

  if (receipts.length === 0 && charts.length === 0) return null;

  return (
    <div className={styles.artifacts}>
      {receipts}
      {charts.length > 0 ? (
        <div className={multiChart ? styles.chartGrid : undefined}>{charts}</div>
      ) : null}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { DataColumn, DataRow } from "@/components/ui";
import {
  Card,
  DataTable,
  EChart,
  SegmentedControl,
  SqlBlock,
  StatTile,
} from "@/components/ui";
import { asChartSpec, optionFromSpec } from "./chartFromSpec";
import { QUERY_CLICKHOUSE, RENDER_CHART } from "./steps";
import styles from "./AgentTurn.module.css";

/**
 * What the agent actually got back, rendered as artifacts under the answer.
 *
 * Every shape decision here is made from the *result*, never from a table name:
 * the columns are whatever keys the rows came back with, so this renders a
 * taxi fare table and a Kubernetes pod table identically well.
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
 * so a numeric string counts as a number here — but only when it round-trips,
 * so an id-like string is never silently reformatted with thousands separators.
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
 * One row, one column, one number — an answer that *is* a figure, so it reads
 * as one rather than as a 1x1 table. Anything else falls through to the table.
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

/** Renders the artifacts of one completed queryClickhouse call. */
function QueryArtifact({ sql, result }: { sql?: string; result: unknown }) {
  const rows = toRows(result);
  const stat = singleStat(rows);
  const shown = rows.slice(0, MAX_ROWS);

  return (
    <>
      {stat ? (
        <Card>
          <StatTile label={stat.label} value={stat.value} />
        </Card>
      ) : rows.length > 0 ? (
        <Card padding="none" clip>
          <DataTable
            columns={toColumns(rows)}
            rows={shown}
            maxHeight="320px"
            footer={
              <>
                <span>
                  {rows.length > shown.length
                    ? `${COUNT.format(shown.length)} of ${COUNT.format(rows.length)} rows`
                    : `${COUNT.format(rows.length)} row${rows.length === 1 ? "" : "s"}`}
                </span>
              </>
            }
          />
        </Card>
      ) : null}

      {/* The query is the receipt for the numbers above it, so it ships with
          them — collapsed, but never absent. */}
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
 * A chart the agent asked for, with a chart | table toggle (per the design's
 * chart frame). If flint can't compile the spec — a bad field, an empty result —
 * it degrades to the table rather than showing nothing.
 */
function ChartArtifact({ spec: raw }: { spec: unknown }) {
  const spec = useMemo(() => asChartSpec(raw), [raw]);
  const option = useMemo(() => (spec ? optionFromSpec(spec) : null), [spec]);
  const [view, setView] = useState<"chart" | "table">("chart");

  if (!spec) return null;

  const rows = spec.data as DataRow[];
  const table = (
    <Card padding="none" clip>
      <DataTable
        columns={toColumns(rows)}
        rows={rows.slice(0, MAX_ROWS)}
        maxHeight="320px"
      />
    </Card>
  );

  // Nothing to toggle to if flint couldn't build the chart — just show the data.
  if (!option) return table;

  return (
    <Card>
      <div className={styles.chartHead}>
        <span className={styles.chartTitle}>{spec.title}</span>
        <SegmentedControl
          aria-label="result view"
          value={view}
          onChange={setView}
          options={[
            { value: "chart", label: "chart" },
            { value: "table", label: "table" },
          ]}
        />
      </div>
      {view === "chart" ? <EChart option={option} /> : table}
    </Card>
  );
}

/**
 * Held back until the message completes, and deliberately so. The parts stream
 * in tool-then-text order, so rendering results the moment they land would put
 * a table above the prose and then shove it down with every token. Mounting
 * once, at the end, is both the design's order and the reason the reading
 * column doesn't jump while text streams.
 */
export function Artifacts() {
  const parts = useAuiState((s) => s.message.parts);

  // Artifacts render in the order the agent produced them: a query's table/stat,
  // then a chart it drew from those rows.
  const rendered = parts.flatMap((part, i) => {
    if (
      part.type !== "tool-call" ||
      part.status.type !== "complete" ||
      part.isError
    ) {
      return [];
    }

    if (part.toolName === QUERY_CLICKHOUSE) {
      const args = isRecord(part.args) ? part.args : {};
      const sql = typeof args["sql"] === "string" ? args["sql"] : undefined;
      return [
        <QueryArtifact key={part.toolCallId ?? i} sql={sql} result={part.result} />,
      ];
    }

    if (part.toolName === RENDER_CHART) {
      // The tool echoes its input as output; args is the spec either way.
      return [<ChartArtifact key={part.toolCallId ?? i} spec={part.args} />];
    }

    return [];
  });

  if (rendered.length === 0) return null;

  return <div className={styles.artifacts}>{rendered}</div>;
}

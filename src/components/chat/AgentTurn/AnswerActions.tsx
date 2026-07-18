"use client";

import { useMemo, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Button, chartSpan } from "@/components/ui";
import { WatchModal } from "@/components/watch";
import type { WatchActions, WatchMetric } from "@/components/watch/model";
import {
  acknowledgeAlertAction,
  createWatcherAction,
  deleteWatcherAction,
  setWatcherStateAction,
} from "@/app/watch/actions";
import {
  BoardPickerModal,
  type PinnableChart,
  type PinnableStat,
} from "./BoardPickerModal";
import { QUERY_CLICKHOUSE, RENDER_CHART, RENDER_STAT } from "./steps";
import styles from "./AgentTurn.module.css";

/**
 * The bar under a finished answer. It appears once the turn produced a chart or
 * a stat — a text-only reply has nothing to watch or pin — and it reuses the
 * message's own queries, chart titles and stat labels so the actions carry real
 * content. "Add to dashboard" pins everything the answer showed (charts and
 * KPIs) at once, which is how a dashboard-style answer becomes a board in one
 * click.
 */

const watchActions: WatchActions = {
  setState: setWatcherStateAction,
  remove: deleteWatcherAction,
  create: createWatcherAction,
  acknowledge: acknowledgeAlertAction,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce a channel→field map to strings, dropping anything else. */
function stringMap(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
}

/** A value that reads as a number (ClickHouse hands big ints back as strings). */
function asNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** One completed query, indexed by stream position, with what it returned. */
interface QueryInfo {
  sql: string;
  idx: number;
  /** Column names in its result — used to match a chart's encoding fields. */
  columns: Set<string>;
  /** First-row column→number cells — used to match a stat to its value + column. */
  cells: { column: string; value: number }[];
}

/**
 * Every chart/stat the turn drew, each paired with the query that fed it.
 *
 * The agent BATCHES: it can fire several queries and then several render calls
 * in one step, so "the query most recently before this chart" pins the wrong
 * SQL on nearly every tile (they all grab the last query's SQL — which is what
 * left the board full of broken charts and KPIs reading the same stray number).
 * Instead, pair by CONTENT: a chart takes the query whose result columns cover
 * its encoding fields; a stat takes the query whose row holds its value. The
 * chart renders in chat from embedded data regardless, so this only matters when
 * a tile re-runs its SQL on a board — which is exactly where it was breaking.
 */
function useAnswerArtifacts(): {
  charts: PinnableChart[];
  stats: PinnableStat[];
} {
  const parts = useAuiState((s) => s.message.parts);
  return useMemo(() => {
    const completed = parts.filter(
      (p): p is Extract<(typeof parts)[number], { type: "tool-call" }> =>
        p.type === "tool-call" && p.status.type === "complete" && !p.isError,
    );

    // Index every query by its position, with its columns and first-row numbers.
    const queries: QueryInfo[] = [];
    completed.forEach((part, idx) => {
      const args = isRecord(part.args) ? part.args : {};
      if (part.toolName !== QUERY_CLICKHOUSE || typeof args["sql"] !== "string") {
        return;
      }
      const rows = Array.isArray(part.result)
        ? part.result.filter(isRecord)
        : [];
      const first = rows[0] ?? {};
      const cells: { column: string; value: number }[] = [];
      for (const [column, raw] of Object.entries(first)) {
        const value = asNum(raw);
        if (value !== null) cells.push({ column, value });
      }
      queries.push({
        sql: args["sql"],
        idx,
        columns: new Set(Object.keys(first)),
        cells,
      });
    });

    // Prefer the closest matching query at or before this artifact; fall back to
    // the nearest preceding query, then to any query at all.
    const poolFor = (idx: number) => {
      const before = queries.filter((q) => q.idx <= idx);
      return before.length > 0 ? before : queries;
    };
    const sqlForChart = (fields: string[], idx: number): string => {
      const pool = poolFor(idx);
      for (let i = pool.length - 1; i >= 0; i--) {
        if (fields.every((f) => pool[i]!.columns.has(f))) return pool[i]!.sql;
      }
      return pool.at(-1)?.sql ?? "";
    };
    // A stat matches the query whose first row holds its value, AND the specific
    // column that holds it — so on the board toKpi reads that column, not the
    // first numeric one (a "summarize the KPIs" query returns several metrics).
    const matchStat = (
      value: number | null,
      idx: number,
    ): { sql: string; valueColumn?: string } => {
      const pool = poolFor(idx);
      if (value !== null) {
        // The stat carries the DISPLAYED number (rounded, e.g. 16.23) while the
        // query returns full precision (16.2328…) — so match on a 0.5% relative
        // band (with a small absolute floor) rather than near-exact equality.
        const tol = Math.max(Math.abs(value) * 5e-3, 1e-2);
        for (let i = pool.length - 1; i >= 0; i--) {
          const hit = pool[i]!.cells.find((c) => Math.abs(c.value - value) <= tol);
          if (hit) return { sql: pool[i]!.sql, valueColumn: hit.column };
        }
      }
      return { sql: pool.at(-1)?.sql ?? "" };
    };

    const charts: PinnableChart[] = [];
    const stats: PinnableStat[] = [];
    completed.forEach((part, idx) => {
      const args = isRecord(part.args) ? part.args : {};

      if (part.toolName === RENDER_CHART && typeof args["chartType"] === "string") {
        const encodings = stringMap(args["encodings"]);
        const data = Array.isArray(args["data"])
          ? args["data"].filter(isRecord)
          : [];
        const spec = {
          chartType: args["chartType"],
          encodings,
          ...(args["horizontal"] === true ? { horizontal: true } : {}),
          ...(isRecord(args["semanticTypes"])
            ? { semanticTypes: stringMap(args["semanticTypes"]) }
            : {}),
        };
        // The chat grid is 2 columns, the board's is 4 — double the chart's chat
        // footprint so a full-row chat chart stays full-row on the board instead
        // of collapsing to the kind default (half).
        const span = Math.min(chartSpan({ ...spec, title: "", data }) * 2, 4);
        charts.push({
          title:
            typeof args["title"] === "string" && args["title"]
              ? args["title"]
              : "Chart",
          sql: sqlForChart(Object.values(encodings), idx),
          spec: { ...spec, span },
        });
      }

      if (
        part.toolName === RENDER_STAT &&
        typeof args["label"] === "string" &&
        args["label"].trim() !== ""
      ) {
        const unit = args["unit"];
        const match = matchStat(asNum(args["value"]), idx);
        stats.push({
          label: args["label"].trim(),
          sql: match.sql,
          ...(match.valueColumn ? { valueColumn: match.valueColumn } : {}),
          ...(unit === "$" || unit === "%" || unit === "×" ? { unit } : {}),
        });
      }
    });

    return { charts, stats };
  }, [parts]);
}

export function AnswerActions() {
  const { charts, stats } = useAnswerArtifacts();
  const [watchOpen, setWatchOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);

  // Watching and pinning only make sense once there's a chart or a stat to
  // stand for — a text-only reply has nothing to pin.
  const count = charts.length + stats.length;
  if (count === 0) return null;

  const many = count > 1;
  // Every action needs one base metric to work off. The headline is the first
  // chart the agent led with, or — for a number-only answer — the first stat.
  // Both carry a name + the query that produced them, which is all these need.
  const headline = charts[0]
    ? { title: charts[0].title, sql: charts[0].sql }
    : { title: stats[0]!.label, sql: stats[0]!.sql };
  const metric: WatchMetric = {
    label: headline.title,
    sql: headline.sql,
    current: null,
    observedAt: new Date(),
  };

  return (
    <div className={styles.actions}>
      <Button size="sm" icon="▦" onClick={() => setBoardOpen(true)}>
        {many ? `Add ${count} to dashboard` : "Add to dashboard"}
      </Button>

      <Button
        size="sm"
        variant="primary"
        icon="◉"
        onClick={() => setWatchOpen(true)}
      >
        Set as watcher
      </Button>

      <WatchModal
        open={watchOpen}
        onClose={() => setWatchOpen(false)}
        actions={watchActions}
        metric={metric}
      />
      <BoardPickerModal
        open={boardOpen}
        onClose={() => setBoardOpen(false)}
        charts={charts}
        stats={stats}
      />
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Button } from "@/components/ui";
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

/**
 * Every chart the turn drew, each paired with the query that fed it.
 *
 * The tool stream is query→chart→query→chart…, so a chart's data is whatever
 * queryClickhouse ran most recently before it. Walking in order and remembering
 * the last SQL pairs them without the agent having to thread an id.
 */
function useAnswerArtifacts(): {
  charts: PinnableChart[];
  stats: PinnableStat[];
} {
  const parts = useAuiState((s) => s.message.parts);
  return useMemo(() => {
    let lastSql = "";
    const charts: PinnableChart[] = [];
    const stats: PinnableStat[] = [];
    for (const part of parts) {
      if (
        part.type !== "tool-call" ||
        part.status.type !== "complete" ||
        part.isError
      ) {
        continue;
      }
      const args = isRecord(part.args) ? part.args : {};
      if (part.toolName === QUERY_CLICKHOUSE && typeof args["sql"] === "string") {
        lastSql = args["sql"];
      }
      if (part.toolName === RENDER_CHART && typeof args["chartType"] === "string") {
        charts.push({
          title:
            typeof args["title"] === "string" && args["title"]
              ? args["title"]
              : "Chart",
          sql: lastSql,
          spec: {
            chartType: args["chartType"],
            encodings: stringMap(args["encodings"]),
            ...(args["horizontal"] === true ? { horizontal: true } : {}),
            ...(isRecord(args["semanticTypes"])
              ? { semanticTypes: stringMap(args["semanticTypes"]) }
              : {}),
          },
        });
      }
      // A stat pairs with the query before it, exactly like a chart: its label
      // is the metric's name, its unit a display hint the KPI tile carries.
      if (
        part.toolName === RENDER_STAT &&
        typeof args["label"] === "string" &&
        args["label"].trim() !== ""
      ) {
        const unit = args["unit"];
        stats.push({
          label: args["label"].trim(),
          sql: lastSql,
          ...(unit === "$" || unit === "%" || unit === "×" ? { unit } : {}),
        });
      }
    }
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

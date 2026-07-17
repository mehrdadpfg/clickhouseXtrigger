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
import { BoardPickerModal, type PinnableChart } from "./BoardPickerModal";
import { QUERY_CLICKHOUSE, RENDER_CHART } from "./steps";
import styles from "./AgentTurn.module.css";

/**
 * The bar under a finished answer. It only appears once the turn produced a
 * chart — a text-only reply has nothing to watch or pin — and it reuses the
 * message's own queries and chart titles so the actions carry real content.
 * When the turn drew several charts, "Add to dashboard" pins all of them at
 * once, which is how a dashboard-style answer becomes a board in one click.
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
function useAnswerArtifacts(): { charts: PinnableChart[] } {
  const parts = useAuiState((s) => s.message.parts);
  return useMemo(() => {
    let lastSql = "";
    const charts: PinnableChart[] = [];
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
    }
    return { charts };
  }, [parts]);
}

export function AnswerActions() {
  const { charts } = useAnswerArtifacts();
  const [watchOpen, setWatchOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);

  // Watching and pinning only make sense once there's a chart to stand for.
  if (charts.length === 0) return null;

  const many = charts.length > 1;
  // A watcher is a single metric — for a multi-chart answer it stands for the
  // first chart, which is the headline the agent led with.
  const first = charts[0]!;
  const metric: WatchMetric = {
    label: first.title,
    sql: first.sql,
    current: null,
    observedAt: new Date(),
  };

  return (
    <div className={styles.actions}>
      <Button size="sm" icon="▦" onClick={() => setBoardOpen(true)}>
        {many ? `Add ${charts.length} to dashboard` : "Add to dashboard"}
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
      />
    </div>
  );
}

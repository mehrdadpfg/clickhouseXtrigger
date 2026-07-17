"use client";

import { useMemo, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Button } from "@/components/ui";
import type { ChartSpec } from "@/components/ui";
import { WatchModal } from "@/components/watch";
import type { WatchActions, WatchMetric } from "@/components/watch/model";
import {
  acknowledgeAlertAction,
  createWatcherAction,
  deleteWatcherAction,
  setWatcherStateAction,
} from "@/app/watch/actions";
import { BoardPickerModal } from "./BoardPickerModal";
import { QUERY_CLICKHOUSE, RENDER_CHART } from "./steps";
import styles from "./AgentTurn.module.css";

type PinnableSpec = Pick<ChartSpec, "chartType" | "encodings"> &
  Partial<Pick<ChartSpec, "horizontal" | "semanticTypes">>;

/**
 * The bar under a finished answer. It only appears once the turn produced a
 * chart — a text-only reply has nothing to watch or pin — and it reuses the
 * message's own query and chart title so the actions carry real content.
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

/** The SQL, chart title, and pinnable chart spec this turn produced. */
function useAnswerArtifacts() {
  const parts = useAuiState((s) => s.message.parts);
  return useMemo(() => {
    let sql: string | undefined;
    let title: string | undefined;
    let spec: PinnableSpec | undefined;
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
        sql = args["sql"];
      }
      if (part.toolName === RENDER_CHART && typeof args["chartType"] === "string") {
        if (typeof args["title"] === "string") title = args["title"];
        spec = {
          chartType: args["chartType"],
          encodings: stringMap(args["encodings"]),
          ...(args["horizontal"] === true ? { horizontal: true } : {}),
          ...(isRecord(args["semanticTypes"])
            ? { semanticTypes: stringMap(args["semanticTypes"]) }
            : {}),
        };
      }
    }
    return { sql, title, spec, hasChart: spec !== undefined };
  }, [parts]);
}

export function AnswerActions() {
  const { sql, title, spec, hasChart } = useAnswerArtifacts();
  const [watchOpen, setWatchOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);

  // Watching and pinning only make sense once there's a chart to stand for.
  if (!hasChart || !spec) return null;

  const chartTitle = title || "Chart";
  const query = sql ?? "";
  const metric: WatchMetric = {
    label: chartTitle,
    sql: query,
    current: null,
    observedAt: new Date(),
  };

  return (
    <div className={styles.actions}>
      <Button size="sm" icon="▦" onClick={() => setBoardOpen(true)}>
        Add to dashboard
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
        title={chartTitle}
        sql={query}
        spec={spec}
      />
    </div>
  );
}

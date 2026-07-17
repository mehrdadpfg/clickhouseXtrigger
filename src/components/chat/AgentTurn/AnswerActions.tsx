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
import { QUERY_CLICKHOUSE, RENDER_CHART } from "./steps";
import styles from "./AgentTurn.module.css";

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

/** The SQL and chart title this turn produced, and whether it drew a chart. */
function useAnswerArtifacts() {
  const parts = useAuiState((s) => s.message.parts);
  return useMemo(() => {
    let sql: string | undefined;
    let title: string | undefined;
    let hasChart = false;
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
      if (part.toolName === RENDER_CHART) {
        hasChart = true;
        if (typeof args["title"] === "string") title = args["title"];
      }
    }
    return { sql, title, hasChart };
  }, [parts]);
}

export function AnswerActions() {
  const { sql, title, hasChart } = useAnswerArtifacts();
  const [watchOpen, setWatchOpen] = useState(false);

  // Watching and pinning only make sense once there's a chart to stand for.
  if (!hasChart) return null;

  const metric: WatchMetric = {
    label: title || "this metric",
    sql: sql ?? "",
    current: null,
    observedAt: new Date(),
  };

  return (
    <div className={styles.actions}>
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
    </div>
  );
}

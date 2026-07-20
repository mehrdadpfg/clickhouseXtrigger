"use client";

import { useMemo, useRef, useState } from "react";
import { useThreadRuntime } from "@assistant-ui/react";
import { Eye } from "lucide-react";
import type { ChartSpec, DataColumn, DataRow, EChartHandle } from "@/components/ui";
import {
  DataTable,
  EChart,
  ExportMenu,
  Modal,
  optionFromSpec,
  slugify,
} from "@/components/ui";
import styles from "./ChartWorkspace.module.css";

/**
 * One chart, opened on demand into a floating workspace.
 *
 * The grid tile is a thumbnail: read-only, sized to tile beside its siblings.
 * This is where the same chart becomes workable — big enough to select a range
 * on, and the only surface where direct manipulation is armed. Keeping the two
 * apart means a mis-click on a dashboard tile can never fire a query.
 *
 * Answers do NOT accumulate here. An interaction appends to the thread and the
 * workspace closes, so the conversation stays the single record of what was
 * asked — the mistake the old docked panel made was becoming a second app.
 */
export function ChartWorkspace({
  spec,
  view,
  open,
  onClose,
}: {
  spec: ChartSpec;
  /** The reader's chart-type pick from the tile, so the workspace opens as seen. */
  view: string;
  open: boolean;
  onClose: () => void;
}) {
  const thread = useThreadRuntime();
  const chartRef = useRef<EChartHandle>(null);
  const [asTable, setAsTable] = useState(false);

  const option = useMemo(
    () => (asTable ? null : optionFromSpec({ ...spec, chartType: view || spec.chartType })),
    [spec, view, asTable],
  );

  const rows = spec.data as DataRow[];
  const columns: DataColumn[] = useMemo(() => {
    const first = rows[0];
    return first ? Object.keys(first).map((key) => ({ key, label: key })) : [];
  }, [rows]);

  // Every interaction leaves by the same door: say what was selected in plain
  // language, let the agent re-derive the SQL from the turn it already wrote.
  const ask = (question: string) => {
    onClose();
    thread.append(question);
  };

  return (
    <Modal open={open} onClose={onClose} title={spec.title || "Chart"} size="workspace">
      <div className={styles.body}>
        <div className={styles.tools}>
          <button
            type="button"
            className={styles.tool}
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? "Chart" : "Table"}
          </button>
          <button
            type="button"
            className={styles.tool}
            onClick={() =>
              ask(
                `Set up a watcher on "${spec.title}". Ask me which number from this chart to watch and what threshold should trip it before you create it.`,
              )
            }
          >
            <Eye size={14} strokeWidth={2} aria-hidden="true" />
            Watch
          </button>
          {!asTable ? (
            <ExportMenu
              chartRef={chartRef}
              filename={slugify(spec.title)}
              buttonClassName={styles.tool}
            />
          ) : null}
        </div>

        <div className={styles.stage}>
          {asTable || !option ? (
            <DataTable columns={columns} rows={rows} />
          ) : (
            <EChart ref={chartRef} option={option} height={460} />
          )}
        </div>
      </div>
    </Modal>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useThreadRuntime } from "@assistant-ui/react";
import { Eye, LayoutDashboard, Table as TableIcon } from "lucide-react";
import type { DataColumn, DataRow, EChartHandle } from "@/components/ui";
import { DataTable, EChart, ExportMenu, optionFromSpec, slugify } from "@/components/ui";
import { markUiAction } from "../uiAction";
import { useWorkspace } from "./WorkspaceProvider";
import styles from "./ChartWorkspace.module.css";

/**
 * The floating canvas: a toolbar over one chart, in a shell that pushes the
 * thread aside rather than covering it.
 *
 * Interactions leave by one door — say what was selected in plain language and
 * append it to the thread, letting the agent re-derive the SQL from the turn it
 * already wrote. The canvas stays open while the answer streams in behind it, so
 * drilling is a loop rather than a round trip.
 */
export function WorkspacePanel() {
  const { current, isOpen, close } = useWorkspace();
  const thread = useThreadRuntime();
  const chartRef = useRef<EChartHandle>(null);
  const [asTable, setAsTable] = useState(false);

  // A new chart always opens as a chart, never inheriting the last one's toggle.
  const currentId = current?.id ?? null;
  useEffect(() => {
    setAsTable(false);
  }, [currentId]);

  // Esc closes. The shell is a push panel, not a Radix dialog, so this is ours
  // to wire — along with leaving the thread focusable, which is the point.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  const spec = current?.spec ?? null;
  const view = current?.view ?? "";

  const option = useMemo(() => {
    if (!spec || asTable) return null;
    return optionFromSpec({ ...spec, chartType: view || spec.chartType });
  }, [spec, view, asTable]);

  const rows = (spec?.data ?? []) as DataRow[];
  const columns: DataColumn[] = useMemo(() => {
    const first = rows[0];
    return first ? Object.keys(first).map((key) => ({ key, label: key })) : [];
  }, [rows]);

  const ask = (question: string) => thread.append(question);

  return (
    <aside
      className={`${styles.panel} ${isOpen ? styles.panelOpen : ""}`}
      aria-hidden={!isOpen}
    >
      <div className={styles.inner}>
        <div className={styles.surface}>
          <div className={styles.toolbar}>
            <div className={styles.toolbarBrand}>
              <span className={styles.toolbarIcon} aria-hidden="true">
                <LayoutDashboard size={15} strokeWidth={2} />
              </span>
              <span className={styles.toolbarTitle}>
                {spec?.title || "Chart"}
              </span>
            </div>

            <div className={styles.toolbarActions}>
              <button
                type="button"
                className={styles.toolbarBtn}
                onClick={() => setAsTable((v) => !v)}
              >
                <TableIcon size={14} strokeWidth={2} aria-hidden="true" />
                {asTable ? "Chart" : "Table"}
              </button>
              <button
                type="button"
                className={styles.toolbarBtn}
                onClick={() =>
                  spec &&
                  ask(
                    markUiAction(
                      "Watch",
                      `Set up a watcher on "${spec.title}". Ask me which number from this chart to watch and what threshold should trip it before you create it.`,
                    ),
                  )
                }
              >
                <Eye size={14} strokeWidth={2} aria-hidden="true" />
                Watch
              </button>
              {!asTable && spec ? (
                <ExportMenu
                  chartRef={chartRef}
                  filename={slugify(spec.title)}
                  buttonClassName={styles.toolbarBtn}
                />
              ) : null}
              <button
                type="button"
                className={styles.close}
                onClick={close}
                aria-label="Close the workspace"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
          </div>

          <div className={styles.stage}>
            {!spec ? null : asTable || !option ? (
              <div className={styles.tableWrap}>
                <DataTable columns={columns} rows={rows} />
              </div>
            ) : (
              <EChart ref={chartRef} option={option} height={520} />
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

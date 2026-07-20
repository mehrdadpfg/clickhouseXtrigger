"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useThreadRuntime } from "@assistant-ui/react";
import { Eye, LayoutDashboard, Table as TableIcon } from "lucide-react";
import type { DataColumn, DataRow, EChartHandle } from "@/components/ui";
import {
  DataTable,
  EChart,
  ExportMenu,
  optionFromSpec,
  prettify,
  slugify,
  SqlCode,
} from "@/components/ui";
import { getSchemaNamespace, runWorkspaceQuery } from "@/app/chats/actions";
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
  // The edited query and whatever it last returned. Null rows = showing the
  // agent's original data; a successful run replaces them for this session only,
  // so the turn in the thread stays the record of what the agent actually drew.
  const [draft, setDraft] = useState("");
  const [ranRows, setRanRows] = useState<DataRow[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  // Loaded once per mount, not per chart: the namespace is the same for every
  // chart in the thread, and it is cached server-side besides.
  const [schema, setSchema] = useState<
    Record<string, Record<string, string[]>> | undefined
  >();

  useEffect(() => {
    let live = true;
    void getSchemaNamespace().then((ns) => {
      if (live) setSchema(ns);
    });
    return () => {
      live = false;
    };
  }, []);

  // A new chart always opens as a chart, never inheriting the last one's toggle.
  const currentId = current?.id ?? null;
  useEffect(() => {
    setAsTable(false);
    setRanRows(null);
    setRunError(null);
  }, [currentId]);

  // Seed the editor from the chart's own query, laid out. Keyed on the chart so
  // switching charts loads the new one without clobbering an in-progress edit.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededFor.current === currentId) return;
    seededFor.current = currentId;
    setDraft(current?.spec.sql ? prettify(current.spec.sql) : "");
  }, [currentId, current]);

  const run = async () => {
    if (running || draft.trim() === "") return;
    setRunning(true);
    setRunError(null);
    const result = await runWorkspaceQuery(draft);
    if (result.ok) {
      setRanRows(result.rows as DataRow[]);
      // Empty is a real answer, but an empty chart looks broken — say so.
      if (result.rows.length === 0) setRunError("The query returned no rows.");
    } else {
      setRunError(result.error);
    }
    setRunning(false);
  };

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

  const rows = (ranRows ?? spec?.data ?? []) as DataRow[];

  /**
   * The table the chart's own query reads, so its columns complete unqualified.
   * A first FROM is the right guess here: these queries aggregate one table, and
   * on the rare join the reader can still qualify the other side by hand.
   */
  const fromRef = useMemo(() => {
    const match = /\bfrom\s+([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/i.exec(spec?.sql ?? "");
    return match ? { db: match[1]!, table: match[2]! } : null;
  }, [spec]);

  const option = useMemo(() => {
    if (!spec || asTable || rows.length === 0) return null;
    // Re-encode the returned rows with the chart's existing channels. A query
    // that no longer projects those columns simply won't compile, and the stage
    // falls back to the table — which is the honest view of an unexpected shape.
    return optionFromSpec({ ...spec, chartType: view || spec.chartType, data: rows });
  }, [spec, view, asTable, rows]);
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
              <EChart ref={chartRef} option={option} height={420} />
            )}

            {/* Grafana's shape: the chart, then the query that produced it. Not
                a disclosure — in a workspace the query is part of the reading,
                and hiding it behind a toggle is what made it feel like a
                receipt rather than the thing you are working on. */}
            {spec?.sql ? (
              <div className={styles.query}>
                <div className={styles.queryHead}>
                  <span>Query</span>
                  <button
                    type="button"
                    className={styles.queryTool}
                    onClick={() => setDraft(prettify(draft))}
                  >
                    Format
                  </button>
                  <button
                    type="button"
                    className={styles.queryTool}
                    onClick={() => {
                      void navigator.clipboard.writeText(draft);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1400);
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <span className={styles.queryHint}>⌘⏎ to run</span>
                  <button
                    type="button"
                    className={styles.runBtn}
                    onClick={() => void run()}
                    disabled={running || draft.trim() === ""}
                  >
                    {running ? "Running…" : "Run"}
                  </button>
                </div>
                <SqlCode
                  value={draft}
                  onChange={setDraft}
                  onRun={() => void run()}
                  {...(schema ? { schema } : {})}
                  {...(fromRef
                    ? { defaultTable: fromRef.table, defaultSchema: fromRef.db }
                    : {})}
                  editable
                />
                {runError ? <p className={styles.queryError}>{runError}</p> : null}
                {ranRows && !runError ? (
                  <p className={styles.queryOk}>
                    {ranRows.length} row{ranRows.length === 1 ? "" : "s"} — showing your edit,
                    not the agent{"\u2019"}s original.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  );
}

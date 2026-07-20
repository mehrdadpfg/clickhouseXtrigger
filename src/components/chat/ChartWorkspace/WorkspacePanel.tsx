"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuiState, useThreadRuntime } from "@assistant-ui/react";
import { Check, Copy, Eye, LayoutDashboard, RotateCcw } from "lucide-react";
import type { DataColumn, DataRow, EChartHandle } from "@/components/ui";
import {
  asChartSpec,
  chartSpan,
  DataTable,
  EChart,
  ExportMenu,
  optionFromSpec,
  prettify,
  slugify,
  SqlCode,
} from "@/components/ui";
import {
  getMaxDate,
  getSchemaNamespace,
  runWorkspaceQuery,
} from "@/app/chats/actions";
import { BoardPickerModal } from "../AgentTurn/BoardPickerModal";
import { ChartTypeMenu, recast, TABLE_VIEW } from "../ChartType";
import { readBucket, readCoverage, type Coverage } from "./coverage";
import { markUiAction } from "../uiAction";
import { useWorkspace } from "./WorkspaceProvider";
import styles from "./ChartWorkspace.module.css";
import { Tooltip } from "@/components/ui";

/**
 * The floating canvas: a toolbar over one chart, in a shell that pushes the
 * thread aside rather than covering it.
 *
 * Interactions leave by one door — say what was selected in plain language and
 * append it to the thread, letting the agent re-derive the SQL from the turn it
 * already wrote. The canvas stays open while the answer streams in behind it, so
 * drilling is a loop rather than a round trip.
 */
const COUNT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatCount(n: number): string {
  return n < 1000 ? String(n) : COUNT.format(n);
}

/** Binary units, because that is what ClickHouse reports and what a reader
 *  comparing "did this scan the whole table?" is thinking in. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

export function WorkspacePanel() {
  const { current, isOpen, close, open, expectDrill, drillPending, clearDrill } =
    useWorkspace();
  const thread = useThreadRuntime();
  const chartRef = useRef<EChartHandle>(null);
  // "" = the chart as the agent drew it; otherwise the reader's pick (a
  // chartType or TABLE_VIEW). Recast client-side, so switching never re-asks.
  const [view, setView] = useState("");
  // The edited query and whatever it last returned. Null rows = showing the
  // agent's original data; a successful run replaces them for this session only,
  // so the turn in the thread stays the record of what the agent actually drew.
  const [draft, setDraft] = useState("");
  const [ranRows, setRanRows] = useState<DataRow[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [cost, setCost] = useState<{
    elapsed: number;
    rowsRead: number;
    bytesRead: number;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [pinning, setPinning] = useState(false);
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
    setView("");
    setRanRows(null);
    setRunError(null);
    setCost(null);
    setCoverage(null);
    setPinning(false);
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
      setCost(result.cost);
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

  const asTable = view === TABLE_VIEW;

  const option = useMemo(() => {
    if (!spec || asTable || rows.length === 0) return null;
    // Re-encode the returned rows with the chart's existing channels. A query
    // that no longer projects those columns simply won't compile, and the stage
    // falls back to the table — which is the honest view of an unexpected shape.
    const target = view || spec.chartType;
    const shaped = target === spec.chartType ? spec : recast(spec, target);
    return optionFromSpec({ ...shaped, data: rows });
  }, [spec, view, asTable, rows]);
  const columns: DataColumn[] = useMemo(() => {
    const first = rows[0];
    return first ? Object.keys(first).map((key) => ({ key, label: key })) : [];
  }, [rows]);

  const ask = (question: string) => thread.append(question);

  /**
   * Clicking a mark asks the agent to break that category down one level finer.
   *
   * The intent goes as plain language, not a structured predicate: the agent
   * re-derives the SQL from the chart's own query, which the chart now carries,
   * so there is nothing to keep in sync. It is deliberately not told WHICH
   * column to split by — nothing in this codebase holds a dimension hierarchy,
   * and the agent can pick a sensible next level from the schema at click time.
   *
   * The canvas stays open: the answer arrives as a new turn behind it, so
   * drilling twice in a row doesn't mean re-opening the chart each time.
   */
  /**
   * Is the x axis ordered? A brushed range only means something on one — across
   * a ranked bar chart "from BRONX to QUEENS" is a set of bars, not a range,
   * so the brush stays unarmed there rather than producing a nonsense question.
   */
  const brushable = useMemo(() => {
    if (!spec) return false;
    const x = spec.encodings["x"];
    if (!x) return false;
    if (spec.semanticTypes?.[x] === "Time") return true;
    const sample = rows.find((r) => r[x] !== null && r[x] !== undefined)?.[x];
    if (typeof sample === "number") return true;
    if (typeof sample !== "string") return false;
    // A ClickHouse date or datetime, or a bare year.
    return /^\d{4}(-\d{2}(-\d{2})?([ T]\d{2}:\d{2})?)?$/.test(sample.trim());
  }, [spec, rows]);

  /**
   * A brushed range asks what drove the shape over that span. Same exit as a
   * click — plain language, the agent re-derives the SQL from the chart's own
   * query — so the two interactions stay one mechanism rather than two.
   */
  const explainRange = (from: string, to: string) => {
    if (!spec) return;
    expectDrill();
    const span = from === to ? from : `${from} to ${to}`;
    ask(
      markUiAction(
        span,
        `In the chart "${spec.title}", something happened between ${from} and ${to}. ` +
          `Investigate that window specifically — compare it against the surrounding ` +
          `periods and name what drove the difference, with the numbers. Chart the evidence.`,
      ),
    );
  };

  /**
   * Is the chart's final bucket a whole period, or one still filling?
   *
   * Costs one max() on the source column, run once per chart. Everything about
   * it fails quiet: no parseable bucket, no date column, no max — no warning.
   */
  useEffect(() => {
    if (!spec?.sql || rows.length === 0 || !fromRef) return;
    const parsed = readBucket(spec.sql);
    if (!parsed) return;
    const x = spec.encodings["x"];
    if (!x) return;
    const lastX = rows[rows.length - 1]?.[x];
    if (lastX === undefined) return;

    let live = true;
    void getMaxDate(fromRef.db, fromRef.table, parsed.column).then((iso) => {
      if (!live || !iso) return;
      setCoverage(readCoverage(lastX, parsed.bucket, new Date(iso)));
    });
    return () => {
      live = false;
    };
    // rows is intentionally excluded: re-running the query shouldn't re-check
    // the source table, whose max hasn't moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, spec, fromRef]);

  /**
   * The last chart of the last assistant turn, and whether the thread is idle.
   *
   * Read from the thread rather than having each tile offer itself on mount:
   * mount order is not answer order — a chart re-mounting from elsewhere in the
   * conversation would claim a pending drill, which is exactly what happened
   * (a taxi chart from another turn took the canvas after a borough drill).
   * The last renderChart of the newest assistant message is unambiguous.
   */
  const newestChartId = useAuiState((state) => {
    const messages = state.thread.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "assistant") continue;
      const parts = message.content ?? [];
      for (let j = parts.length - 1; j >= 0; j -= 1) {
        const part = parts[j] as { type?: string; toolName?: string; toolCallId?: string };
        if (part?.type === "tool-call" && part.toolName === "renderChart") {
          return part.toolCallId ?? null;
        }
      }
      break;
    }
    return null;
  });
  const threadBusy = useAuiState((state) => state.thread.isRunning);

  useEffect(() => {
    if (threadBusy || !newestChartId || !drillPending()) return;
    if (newestChartId === currentId) return;

    // The args are read imperatively rather than selected: a selector returning
    // the parsed spec would build a new object every render, and useAuiState
    // compares snapshots by identity — that loops until React gives up.
    const messages = thread.getState().messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "assistant") continue;
      for (const raw of message.content ?? []) {
        const part = raw as { toolCallId?: string; args?: unknown };
        if (part.toolCallId !== newestChartId) continue;
        const drilled = asChartSpec(part.args);
        if (!drilled) return;
        clearDrill();
        open({ id: newestChartId, spec: drilled, view: "" });
        return;
      }
      break;
    }
  }, [threadBusy, newestChartId, currentId, drillPending, clearDrill, open, thread]);

  /** The agent's own query, laid out — what Reset returns to. */
  const original = useMemo(
    () => (spec?.sql ? prettify(spec.sql) : ""),
    [spec],
  );
  const edited = draft.trim() !== original.trim();

  const reset = () => {
    setDraft(original);
    setRanRows(null);
    setRunError(null);
    setCost(null);
  };

  const drillInto = (category: string) => {
    if (!spec) return;
    // Claim the next chart: the canvas should end up on the answer, not still
    // showing the thing that was clicked.
    expectDrill();
    ask(
      markUiAction(
        category,
        `In the chart "${spec.title}", break down "${category}" one level finer — ` +
          `keep the same measure, and split it by whichever dimension explains ` +
          `the most about that group. Chart the result.`,
      ),
    );
  };

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
              <ChartTypeMenu
                current={asTable ? TABLE_VIEW : view || spec?.chartType || ""}
                allowPie={rows.length <= 12}
                onPick={setView}
                {...(spec?.chartType ? { originalType: spec.chartType } : {})}
                triggerClassName={styles.toolbarBtn}
                showLabel
              />
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
              <Tooltip label="Add this chart to a dashboard">
                <button
                  type="button"
                  className={styles.toolbarBtn}
                  onClick={() => setPinning(true)}
                  disabled={!spec?.sql}
                >
                  <LayoutDashboard size={14} strokeWidth={2} aria-hidden="true" />
                  Pin
                </button>
              </Tooltip>
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
            {coverage ? (
              <p className={styles.coverage}>
                <strong>{coverage.label}</strong> is a partial {coverage.noun} —
                this data ends {coverage.endsAt}, about{" "}
                {Math.round(coverage.fraction * 100)}% through it. The last point
                is lower because the {coverage.noun} isn{"\u2019"}t over.
              </p>
            ) : null}

            {!spec ? null : asTable || !option ? (
              <div className={styles.tableWrap}>
                <DataTable columns={columns} rows={rows} sortable />
              </div>
            ) : (
              <EChart
                ref={chartRef}
                option={option}
                height={420}
                onPick={drillInto}
                {...(brushable ? { onBrush: explainRange } : {})}
              />
            )}

            {/* Grafana's shape: the chart, then the query that produced it. Not
                a disclosure — in a workspace the query is part of the reading,
                and hiding it behind a toggle is what made it feel like a
                receipt rather than the thing you are working on. */}
            {spec?.sql ? (
              <div className={styles.query}>
                <div className={styles.queryHead}>
                  <span>Query</span>
                </div>

                {/* The copy control lives INSIDE the box, over the code it
                    copies, rather than as a chip in the header — it acts on the
                    query, so it belongs on it. */}
                <div className={styles.editorWrap}>
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
                  <Tooltip label={copied ? "Copied" : "Copy the query"}>
                      <button
                      type="button"
                      className={styles.copyBtn}
                      onClick={() => {
                        void navigator.clipboard.writeText(draft);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1400);
                      }}
                      aria-label={copied ? "Copied" : "Copy the query"}
                    >
                      {copied ? (
                        <Check size={14} strokeWidth={2} aria-hidden="true" />
                      ) : (
                        <Copy size={14} strokeWidth={2} aria-hidden="true" />
                      )}
                    </button>
                    </Tooltip>
                </div>

                {/* Run sits under the box, where the eye lands after reading the
                    query rather than above it. */}
                <div className={styles.queryFoot}>
                  <button
                    type="button"
                    className={styles.formatBtn}
                    onClick={() => setDraft(prettify(draft))}
                  >
                    Format
                  </button>
                  {edited ? (
                    <Tooltip label="Back to the query the agent wrote">
                      <button
                        type="button"
                        className={styles.formatBtn}
                        onClick={reset}
                      >
                        <RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
                        Reset
                      </button>
                    </Tooltip>
                  ) : null}
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

                {cost ? (
                  <p className={styles.queryCost}>
                    {cost.elapsed < 1
                      ? `${Math.round(cost.elapsed * 1000)} ms`
                      : `${cost.elapsed.toFixed(2)} s`}
                    {" · "}
                    {formatCount(cost.rowsRead)} rows read
                    {" · "}
                    {formatBytes(cost.bytesRead)} scanned
                  </p>
                ) : null}
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

      {/* Pins the chart AS VIEWED — the reader may have recast it, and the tile
          they get should be the one they were looking at. Span doubling matches
          AnswerActions: the chat is a 2-col grid, a board is 4. */}
      {pinning && spec?.sql ? (
        <BoardPickerModal
          open={pinning}
          onClose={() => setPinning(false)}
          charts={[
            {
              title: spec.title || "Chart",
              sql: spec.sql,
              spec: {
                chartType: (view && view !== TABLE_VIEW ? view : spec.chartType),
                encodings:
                  view && view !== TABLE_VIEW && view !== spec.chartType
                    ? recast(spec, view).encodings
                    : spec.encodings,
                ...(spec.horizontal ? { horizontal: true } : {}),
                ...(spec.semanticTypes ? { semanticTypes: spec.semanticTypes } : {}),
                span: Math.min(chartSpan(spec) * 2, 4),
              },
            },
          ]}
        />
      ) : null}
    </aside>
  );
}

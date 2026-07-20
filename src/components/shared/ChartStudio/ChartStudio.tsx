"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, Copy, LayoutDashboard, RotateCcw } from "lucide-react";
import type {
  ChartSpec,
  DataColumn,
  DataRow,
  EChartHandle,
} from "@/components/ui";
import {
  DataTable,
  EChart,
  optionFromSpec,
  prettify,
  SqlCode,
  Tooltip,
} from "@/components/ui";
import { ChartTypeMenu, recast, TABLE_VIEW } from "@/components/shared/ChartType";
import { readBucket, readCoverage, type Coverage } from "./coverage";
import styles from "./ChartStudio.module.css";

/**
 * ChartStudio — a chart, a live SQL editor over it, a run, its cost, a chart-type
 * menu, and the partial-bucket warning. The one working surface the chat, a board
 * tile, and a watcher all edit a chart through.
 *
 * IT OWNS ITS DRAFT AND RESULT STATE — the edited SQL, the rows a run returned,
 * the cost, the run error, the reader's chart-type pick, and the coverage check.
 * There is exactly one owner of that state and it is here. Hosts do NOT pass rows
 * or cost or a "running" flag in as props: an earlier attempt tried to, alongside
 * a hook owning the same fields, and the two could not both be the truth. A host
 * supplies BEHAVIOUR, never state — chiefly `onRun`, which says what a run means
 * on that surface (a scratch preview in chat, an edit to a saved object on a
 * board) while the studio holds whatever it returns.
 *
 * It deliberately knows nothing of assistant-ui, the chat's workspace, or a board
 * picker. Everything host-specific arrives as a prop: the toolbar `actions`, an
 * under-stage `footer`, an `overlay` drawn over the chart, `onSave`, and the
 * drill callbacks `onPick`/`onBrush`. That is what lets three surfaces share it.
 *
 * To reset for a different chart, the host remounts it with a React `key` on the
 * chart's identity: a fresh mount re-seeds the draft from the new chart's SQL and
 * clears every result. There is no per-chart reset effect for the same reason
 * there is one owner — a swap is a remount, not a state reconciliation.
 */

/** What `onRun` returns: the rows and cost of a successful run, or an error. The
 *  cost shape is ClickHouse's own summary; null means the server didn't report
 *  one, which must not read as "scanned nothing". */
export type StudioRunResult =
  | {
      ok: true;
      rows: Record<string, unknown>[];
      cost: { elapsed: number; rowsRead: number; bytesRead: number } | null;
    }
  | { ok: false; error: string };

/**
 * The bits of studio state a host slot legitimately needs. Passed to `actions`
 * and `footer` so they can compose against the studio without owning its state.
 */
export interface StudioSlot {
  /** The toolbar button chrome, so host actions match the built-in type menu. */
  buttonClass: string;
  /** A table is on the stage (no chart), so a chart-only action can hide. */
  showingTable: boolean;
  /**
   * The reader's raw chart-type pick — "" (as drawn), a chartType, or TABLE_VIEW.
   * A host that saves the chart AS VIEWED (chat's pin-to-dashboard) reads it to
   * recast before persisting.
   */
  view: string;
  /**
   * The query ON SCREEN if the reader edited AND ran one that differs from the
   * chart's original — else null. The chat composer sends it along so the agent
   * answers about what is displayed rather than the query it first wrote.
   */
  editedRanSql: string | null;
  /**
   * The editor's CURRENT text, run or not. `editedRanSql` answers "what is on
   * screen", which is the chat's question; a host that PERSISTS the query — the
   * board tile editor's Save, whose action bar lives in this slot rather than in
   * the built-in `onSave` control — needs whatever is in the box, including an
   * edit the author never pressed Run on, exactly as a plain textarea would save.
   */
  draft: string;
  /** The chart handle, for a host action like export. */
  chartRef: RefObject<EChartHandle | null>;
}

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

export interface ChartStudioProps {
  /** The chart to work on. Null renders an empty toolbar shell (the host keeps
   *  the studio mounted for layout even with nothing open). */
  spec: ChartSpec | null;
  /** Runs a query, returning rows + cost or an error. The host owns what a run
   *  MEANS on its surface; the studio owns the draft and whatever comes back. */
  onRun: (sql: string) => Promise<StudioRunResult>;
  /** The reader's initial chart-type pick; "" opens as the agent drew it. */
  initialView?: string;
  /** Autocomplete namespace for the editor — host-loaded (a server round trip)
   *  and optional; the editor opens without it. */
  schema?: Record<string, Record<string, string[]>>;
  /** Resolves a column's max date, enabling the partial-bucket warning. Without
   *  it there is simply no warning. */
  resolveMaxDate?: (
    db: string,
    table: string,
    column: string,
  ) => Promise<string | null>;
  /** Clicking a mark. Hosts that drill (chat) provide it; others omit it and the
   *  chart is non-interactive. */
  onPick?: (category: string) => void;
  /** Brushing a range on an ordered x axis. Wired only when the axis is ordered
   *  enough for a range to mean something. */
  onBrush?: (from: string, to: string) => void;
  /** Persist the edited query as the chart's own. A Save control appears only
   *  when a host provides this — chat has no saved object to write, so it omits
   *  it and the studio is preview-only. */
  onSave?: (sql: string) => void | Promise<void>;
  /** Host chrome in the toolbar's action cluster (watch, pin, export, close…). */
  actions?: (slot: StudioSlot) => ReactNode;
  /** Host chrome under the stage (the chat's ask-this-chart composer). */
  footer?: (slot: StudioSlot) => ReactNode;
  /** Drawn over the chart — a threshold line, a marker. Click-through by default
   *  so it never steals a drill. */
  overlay?: (ctx: {
    chartRef: RefObject<EChartHandle | null>;
    rows: DataRow[];
  }) => ReactNode;
}

export function ChartStudio({
  spec,
  onRun,
  initialView = "",
  schema,
  resolveMaxDate,
  onPick,
  onBrush,
  onSave,
  actions,
  footer,
  overlay,
}: ChartStudioProps) {
  const chartRef = useRef<EChartHandle>(null);
  // "" = the chart as the agent drew it; otherwise the reader's pick (a
  // chartType or TABLE_VIEW). Recast client-side, so switching never re-asks.
  const [view, setView] = useState(initialView);
  // The edited query and whatever it last returned. Null rows = showing the
  // chart's original data; a successful run replaces them for this session only.
  const [draft, setDraft] = useState("");
  const [ranRows, setRanRows] = useState<DataRow[] | null>(null);
  // The query those rows came from. Kept separately from `draft` because the
  // reader can keep typing after a run: `draft` is what they are writing, this
  // is what the stage is actually showing, and only the latter can honestly be
  // described as the chart on screen.
  const [ranSql, setRanSql] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [cost, setCost] = useState<{
    elapsed: number;
    rowsRead: number;
    bytesRead: number;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [coverage, setCoverage] = useState<Coverage | null>(null);

  // Seed the editor from the chart's own query, laid out. Runs once per mount:
  // the host remounts the studio (via a key) for a different chart, so a new
  // chart is a new mount, and this never clobbers an in-progress edit.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !spec?.sql) return;
    seeded.current = true;
    setDraft(prettify(spec.sql));
  }, [spec]);

  const run = async () => {
    if (running || draft.trim() === "") return;
    setRunning(true);
    setRunError(null);
    const result = await onRun(draft);
    if (result.ok) {
      setRanRows(result.rows as DataRow[]);
      setRanSql(draft);
      setCost(result.cost);
      // Empty is a real answer, but an empty chart looks broken — say so.
      if (result.rows.length === 0) setRunError("The query returned no rows.");
    } else {
      setRunError(result.error);
    }
    setRunning(false);
  };

  const rows = (ranRows ?? spec?.data ?? []) as DataRow[];

  /**
   * The table the chart's own query reads, so its columns complete unqualified.
   * A first FROM is the right guess here: these queries aggregate one table, and
   * on the rare join the reader can still qualify the other side by hand.
   */
  const fromRef = useMemo(() => {
    const match = /\bfrom\s+([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/i.exec(
      spec?.sql ?? "",
    );
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
   * Is the chart's final bucket a whole period, or one still filling?
   *
   * Costs one max() on the source column, run once per chart. Everything about
   * it fails quiet: no resolver, no parseable bucket, no date column, no max —
   * no warning.
   */
  useEffect(() => {
    if (!spec?.sql || rows.length === 0 || !fromRef || !resolveMaxDate) return;
    const parsed = readBucket(spec.sql);
    if (!parsed) return;
    const x = spec.encodings["x"];
    if (!x) return;
    const lastX = rows[rows.length - 1]?.[x];
    if (lastX === undefined) return;

    let live = true;
    void resolveMaxDate(fromRef.db, fromRef.table, parsed.column).then((iso) => {
      if (!live || !iso) return;
      setCoverage(readCoverage(lastX, parsed.bucket, new Date(iso)));
    });
    return () => {
      live = false;
    };
    // rows is intentionally excluded: re-running the query shouldn't re-check
    // the source table, whose max hasn't moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, fromRef, resolveMaxDate]);

  /** The chart's own query, laid out — what Reset returns to. */
  const original = useMemo(() => (spec?.sql ? prettify(spec.sql) : ""), [spec]);
  const edited = draft.trim() !== original.trim();

  const reset = () => {
    setDraft(original);
    setRanRows(null);
    setRanSql(null);
    setRunError(null);
    setCost(null);
  };

  const save = async () => {
    if (!onSave || saving || draft.trim() === "") return;
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  // Only a query that RAN and differs from the original describes what is on
  // screen: until then the stage is still drawing the chart's original rows, and
  // a half-typed edit is neither what the reader sees nor necessarily valid SQL.
  const editedRanSql =
    ranSql !== null && ranSql.trim() !== original.trim() ? ranSql.trim() : null;

  const slot: StudioSlot = {
    buttonClass: styles.toolbarBtn ?? "",
    showingTable: asTable || !option,
    view,
    editedRanSql,
    draft,
    chartRef,
  };

  return (
    <div className={styles.studio}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarBrand}>
          <span className={styles.toolbarIcon} aria-hidden="true">
            <LayoutDashboard size={15} strokeWidth={2} />
          </span>
          <span className={styles.toolbarTitle}>{spec?.title || "Chart"}</span>
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
          {actions?.(slot)}
        </div>
      </div>

      <div className={styles.stage}>
        {coverage ? (
          <p className={styles.coverage}>
            <strong>{coverage.label}</strong> is a partial {coverage.noun} — this
            data ends {coverage.endsAt}, about{" "}
            {Math.round(coverage.fraction * 100)}% through it. The last point is
            lower because the {coverage.noun} isn{"’"}t over.
          </p>
        ) : null}

        {!spec ? null : asTable || !option ? (
          <div className={styles.tableWrap}>
            <DataTable columns={columns} rows={rows} sortable />
          </div>
        ) : (
          <div className={styles.chartWrap}>
            <EChart
              ref={chartRef}
              option={option}
              height={420}
              {...(onPick ? { onPick } : {})}
              {...(brushable && onBrush ? { onBrush } : {})}
            />
            {overlay ? (
              <div className={styles.overlay}>{overlay({ chartRef, rows })}</div>
            ) : null}
          </div>
        )}

        {/* Grafana's shape: the chart, then the query that produced it. Not a
            disclosure — in a studio the query is part of the reading, and hiding
            it behind a toggle is what made it feel like a receipt rather than the
            thing you are working on. */}
        {spec?.sql ? (
          <div className={styles.query}>
            <div className={styles.queryHead}>
              <span>Query</span>
            </div>

            {/* The copy control lives INSIDE the box, over the code it copies,
                rather than as a chip in the header — it acts on the query, so it
                belongs on it. */}
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
                <Tooltip label="Back to the chart's own query">
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
              {onSave ? (
                <button
                  type="button"
                  className={styles.saveBtn}
                  onClick={() => void save()}
                  disabled={saving || draft.trim() === ""}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              ) : null}
              <button
                type="button"
                className={styles.runBtn}
                onClick={() => void run()}
                disabled={running || draft.trim() === ""}
              >
                {running ? "Running…" : "Run"}
              </button>
            </div>

            {runError ? <p className={styles.queryError}>{runError}</p> : null}
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
                {ranRows.length} row{ranRows.length === 1 ? "" : "s"} — showing
                your edit, not the chart{"’"}s original.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Outside .stage, so it stays in reach however far the reader has scrolled
          down the query. */}
      {footer?.(slot)}
    </div>
  );
}

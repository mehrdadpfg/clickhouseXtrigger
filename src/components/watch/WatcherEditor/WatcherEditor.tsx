"use client";

import { useEffect, useMemo, useState, useTransition, type RefObject } from "react";
import type * as echarts from "echarts";
import {
  Button,
  Modal,
  SegmentedControl,
  type ChartSpec,
  type EChartHandle,
} from "@/components/ui";
import {
  ChartStudio,
  type StudioRunResult,
  type StudioSlot,
} from "@/components/shared/ChartStudio";
import {
  getWatchEditorMaxDateAction,
  getWatchEditorSchemaAction,
  runWatcherDraftAction,
} from "@/app/watch/actions";
import {
  CADENCES,
  DIRECTIONS,
  UNITS,
  cadencePhrase,
  formatReading,
  formatThresholdValue,
  type WatchActions,
  type WatcherEdit,
} from "../model";
import type { WatcherDirection } from "@/types/db";
import styles from "./WatcherEditor.module.css";

/**
 * Edit a watcher ON the ChartStudio — the same chart-plus-live-SQL surface the
 * chat and the board tile editor use — hosted in the watch list's PUSH PANEL
 * rather than a modal. The list mounts exactly one of these, keyed on the edited
 * watcher's id, inside a PushPanel that slides the list aside; opening a different
 * watcher is a remount, so the studio and this host re-seed with no reset wiring.
 *
 * This is the former EditWatcherModal with its Modal shell removed: the panel is
 * now the surface. The point of editing here is that the author can see what the
 * SQL returns and where the threshold sits against it. A watcher reduces its query
 * to a single number the way the tick does (the first cell of the first row; see
 * trigger/watchers readScalar), so that number is drawn as one bar and the
 * threshold as a red line across it. The line is an ECharts markLine painted
 * through the studio's `overlay` seam; it never teaches the studio what a watcher
 * is, and it MOVES the instant the threshold field changes.
 *
 * The studio owns the SQL draft, the run, the returned rows and the cost. This
 * host owns only what a watcher adds on top — the question, the threshold
 * (direction + value + unit), the cadence, the Save that persists them, and the
 * Delete (confirmed) that used to sit beside the row. The panel carries no close
 * of its own (showClose={false}); the studio toolbar carries it, matching chat.
 *
 * Saving re-reads: updateWatcherCore takes a fresh reading for an active watcher
 * and waits for it to land (see lib/watchers/create), and the action revalidates
 * /watch, so the list behind reflects the NEW verdict rather than the pre-edit one
 * without a manual reload. This host does not re-run anything itself.
 */

// The synthetic channels the single reading bar is drawn on. A watcher is one
// number, so the studio's chart is one bar: its height is the reading, its label
// the metric. Kept off any real column name so an edited query cannot collide.
// Exported because the CREATE mirror (WatcherCreator) draws the same one bar and
// must stay on the same channels.
export const CATEGORY_KEY = "metric";
export const VALUE_KEY = "reading";

/**
 * The watcher's reading, the way the tick reads it: the first column of the
 * first row, coerced to a number. Null when there is no first row or it is not
 * numeric — the same "not a reading" the runner would hit, surfaced here as an
 * error the author can fix rather than a silently broken watcher.
 */
export function firstNumber(rows: Record<string, unknown>[]): number | null {
  const first = rows[0];
  if (!first) return null;
  const raw = Object.values(first)[0];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function WatcherEditor({
  watcher,
  actions,
  onClose,
}: {
  watcher: WatcherEdit;
  actions: WatchActions;
  /** Close the panel. Wired to the list's editing state. */
  onClose: () => void;
}) {
  // The watcher's own SQL and question are stable identity for this edit — the
  // studio seeds its editor from `sql` once, and the chart title is fixed to the
  // question rather than the live field so a keystroke doesn't churn the spec.
  const seedSql = watcher.sql;
  const seedTitle = watcher.question;
  const metricLabel = watcher.question.trim() || "reading";

  // The panel mounts this fresh per watcher (keyed on the id), so the fields seed
  // straight from props — there is no open/close guard, because a different
  // watcher is a different mount.
  const [question, setQuestion] = useState(watcher.question);
  const [direction, setDirection] = useState<WatcherDirection>(watcher.direction);
  const [value, setValue] = useState(String(watcher.value));
  const [unit, setUnit] = useState(watcher.unit ?? "");
  const [schedule, setSchedule] = useState(watcher.schedule);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [pending, startSave] = useTransition();
  const [removing, startRemove] = useTransition();

  // The reading rows that seed the chart before the author runs anything — a
  // preview run of the stored SQL, so the studio opens with the bar already
  // drawn instead of an empty table. Null until it returns (or fails, in which
  // case the studio opens empty and the author's first Run fills it).
  const [seedRows, setSeedRows] = useState<Record<string, unknown>[] | null>(null);
  const [schema, setSchema] = useState<
    Record<string, Record<string, string[]>> | undefined
  >();

  // Turn a run's rows into the single reading bar. Shared by the seed preview and
  // the studio's own Run so both stay on the same channels.
  const asReadingResult = (
    res: Awaited<ReturnType<typeof runWatcherDraftAction>>,
  ): StudioRunResult => {
    if (!res.ok) return res;
    const scalar = firstNumber(res.rows);
    if (scalar === null) {
      return {
        ok: false,
        error:
          "A watcher reads a single number — this query's first column isn't one.",
      };
    }
    return {
      ok: true,
      rows: [{ [CATEGORY_KEY]: metricLabel, [VALUE_KEY]: scalar }],
      cost: res.cost,
    };
  };

  // Preview the stored reading on mount, and load the autocomplete namespace.
  // Both are best-effort: a failed preview just opens the studio empty, a failed
  // schema load just opens it without completion.
  useEffect(() => {
    let live = true;
    setSeedRows(null);
    void runWatcherDraftAction(seedSql).then((res) => {
      if (!live) return;
      const shaped = asReadingResult(res);
      setSeedRows(shaped.ok ? shaped.rows : []);
    });
    void getWatchEditorSchemaAction().then((ns) => {
      if (live) setSchema(ns);
    });
    return () => {
      live = false;
    };
    // metricLabel is derived from the stable seed question; re-running on every
    // keystroke would refetch the reading for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedSql]);

  const seedSpec = useMemo<ChartSpec>(
    () => ({
      chartType: "Bar Chart",
      title: seedTitle,
      encodings: { x: CATEGORY_KEY, y: VALUE_KEY },
      data: seedRows ?? [],
      sql: seedSql,
    }),
    [seedRows, seedTitle, seedSql],
  );

  const parsed = Number(value);
  const hasValue = value.trim() !== "" && Number.isFinite(parsed);
  // A '% change' threshold is a delta off a baseline, not a level on the reading
  // axis, so there is no honest horizontal line to draw for it. The absolute
  // directions (rises above / drops below) are a bar height, which is exactly
  // what a markLine marks.
  const drawThreshold = hasValue && direction !== "changes_by";

  const thresholdText = hasValue
    ? formatThresholdValue(parsed, unit || undefined)
    : "";

  const save = (draftSql: string) => {
    const finalQuestion = question.trim();
    const finalSql = draftSql.trim();
    if (!finalQuestion) return setError("Give the watcher a question to stand for.");
    if (!finalSql) return setError("A watcher needs SQL to re-run.");
    if (!hasValue) return setError("The threshold must be a number.");

    setError(null);
    startSave(async () => {
      const result = await actions.update?.(watcher.id, {
        question: finalQuestion,
        sql: finalSql,
        schedule,
        direction,
        value: parsed,
        unit: unit || undefined,
      });
      // update is optional on WatchActions; a panel opened without it wired is a
      // caller bug, surfaced rather than silently swallowed.
      if (!result) return setError("Editing is unavailable here.");
      if (result.ok) onClose();
      else setError(result.error);
    });
  };

  const remove = () => {
    setConfirmingRemove(false);
    startRemove(async () => {
      const result = await actions.remove(watcher.id);
      if (result.ok) onClose();
      else setError(result.error);
    });
  };

  const busy = pending || removing;
  const label = question.trim() || "this metric";
  const rule = `${
    DIRECTIONS.find((d) => d.value === direction)?.label ?? direction
  } ${hasValue ? formatThresholdValue(parsed, unit || undefined) : "…"}`;

  return (
    <>
      <ChartStudio
        spec={seedSpec}
        onRun={async (sql) => asReadingResult(await runWatcherDraftAction(sql))}
        {...(schema ? { schema } : {})}
        resolveMaxDate={getWatchEditorMaxDateAction}
        actions={(slot: StudioSlot) => (
          // The panel draws no close of its own (showClose={false}); the studio
          // toolbar carries it, matching the chat's workspace and the board.
          <button
            type="button"
            className={slot.buttonClass}
            onClick={onClose}
            aria-label="Close the watcher editor"
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
        overlay={({ chartRef, rows }) => (
          <ThresholdLine
            chartRef={chartRef}
            rows={rows}
            value={parsed}
            label={thresholdText}
            show={drawThreshold}
          />
        )}
        header={() => (
          <div className={styles.head}>
            <label className={`${styles.field} ${styles.grow}`}>
              <span className={styles.eyebrow}>Question</span>
              <input
                className={styles.input}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="What this watcher stands for"
                autoComplete="off"
              />
            </label>

            <div className={styles.metaRow}>
              <div className={styles.field}>
                <span className={styles.eyebrow}>Alert me when it…</span>
                <SegmentedControl<WatcherDirection>
                  aria-label="Alert me when it…"
                  options={[...DIRECTIONS]}
                  value={direction}
                  onChange={setDirection}
                />
              </div>

              <fieldset className={`${styles.field} ${styles.thresholdField}`}>
                <legend className={styles.eyebrow}>Threshold</legend>
                <div className={styles.threshold}>
                  <label className="sr-only" htmlFor="watch-edit-unit">
                    Unit
                  </label>
                  <select
                    id="watch-edit-unit"
                    className={styles.unit}
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                  >
                    {UNITS.map((u) => (
                      <option key={u.value} value={u.value}>
                        {u.label}
                      </option>
                    ))}
                  </select>

                  <label className="sr-only" htmlFor="watch-edit-value">
                    Threshold value
                  </label>
                  <input
                    id="watch-edit-value"
                    type="number"
                    step="any"
                    inputMode="decimal"
                    className={`tnum ${styles.number}`}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="0"
                  />

                  {direction === "changes_by" ? (
                    <span className={styles.baseline}>vs 4-week average</span>
                  ) : null}
                </div>
              </fieldset>

              <div className={styles.field}>
                <span className={styles.eyebrow}>Check every</span>
                <SegmentedControl
                  aria-label="Check every"
                  options={[...CADENCES]}
                  value={schedule}
                  onChange={setSchedule}
                />
              </div>
            </div>

            <p className={styles.summary}>
              <span className={styles.arrow} aria-hidden="true">
                →
              </span>{" "}
              Alert when <strong>{label}</strong> <strong>{rule}</strong>, checked{" "}
              {cadencePhrase(schedule)}.
              {direction !== "changes_by" && seedRows && seedRows[0] ? (
                <>
                  {" "}
                  Reading now is{" "}
                  <strong className="tnum">
                    {formatReading(
                      Number(seedRows[0][VALUE_KEY]),
                      unit || undefined,
                    )}
                  </strong>
                  .
                </>
              ) : null}
            </p>

          </div>
        )}
        footer={(slot: StudioSlot) => (
          <div className={styles.foot}>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}

            {/* Actions at the foot, aligned with the SQL box's Format/Run. No
                Cancel — the studio toolbar's ✕ already closes the panel. */}
            <div className={styles.actionRow}>
              <Button
                variant="danger"
                onClick={() => setConfirmingRemove(true)}
                disabled={busy}
              >
                Delete watcher
              </Button>
              <div className={styles.spacer} />
              <Button
                variant="primary"
                onClick={() => save(slot.draft)}
                disabled={busy}
              >
                {pending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        )}
      />

      <Modal
        open={confirmingRemove}
        onClose={() => setConfirmingRemove(false)}
        title="Delete this watcher?"
        icon="✕"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmingRemove(false)}>Cancel</Button>
            <Button variant="danger" onClick={remove} disabled={removing}>
              {removing ? "Deleting…" : "Delete watcher"}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          <strong>{watcher.question}</strong> and its alert history will be
          removed. This cannot be undone.
        </p>
      </Modal>
    </>
  );
}

/**
 * Paints the threshold onto the reading bar as an ECharts markLine, via the
 * studio's `overlay` seam — it gets the chart handle, not the studio's innards.
 *
 * It renders no DOM of its own (the line lives on the canvas); the effect is the
 * whole component. `setOption` merges by series index, so it drops a markLine
 * onto series[0] — the single reading bar — without disturbing anything else.
 * The studio re-inits the chart whenever its option changes, which clears the
 * markLine, so the effect re-applies on `value`/`label`/`show` and — the case a
 * run triggers — on `rows`: a fresh run swaps the studio's rows, re-inits the
 * chart on a new instance, and this effect re-runs (after that init, being a
 * later sibling) to paint the line back on.
 */
export function ThresholdLine({
  chartRef,
  rows,
  value,
  label,
  show,
}: {
  chartRef: RefObject<EChartHandle | null>;
  rows: Record<string, unknown>[];
  value: number;
  label: string;
  show: boolean;
}) {
  useEffect(() => {
    const inst = chartRef.current?.getInstance();
    if (!inst) return;

    if (!show) {
      inst.setOption({ series: [{ markLine: { data: [] } }] });
      return;
    }

    const critical =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--critical")
        .trim() || "#f87171";

    const markLine: echarts.MarkLineComponentOption = {
      silent: true,
      symbol: "none",
      animation: false,
      lineStyle: { color: critical, type: "dashed", width: 2 },
      label: {
        formatter: label,
        position: "insideEndTop",
        color: critical,
        fontFamily:
          getComputedStyle(document.documentElement)
            .getPropertyValue("--font-mono")
            .trim() || "monospace",
        fontSize: 11,
      },
      data: [{ yAxis: value }],
    };
    inst.setOption({ series: [{ markLine }] });
  }, [chartRef, rows, value, label, show]);

  return null;
}

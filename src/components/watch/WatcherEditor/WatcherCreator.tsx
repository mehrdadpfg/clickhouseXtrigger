"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  Button,
  SegmentedControl,
  type ChartSpec,
} from "@/components/ui";
import {
  ChartStudio,
  type StudioRunResult,
  type StudioSlot,
} from "@/components/shared/ChartStudio";
import {
  getDefaultNotifyEmailAction,
  getWatchEditorMaxDateAction,
  getWatchEditorSchemaAction,
  runWatcherDraftAction,
} from "@/app/watch/actions";
import {
  CADENCES,
  DIRECTIONS,
  UNITS,
  cadencePhrase,
  formatThresholdValue,
  type WatchActions,
} from "../model";
import type { WatcherDirection } from "@/types/db";
import {
  CATEGORY_KEY,
  VALUE_KEY,
  ThresholdLine,
  firstNumber,
} from "./WatcherEditor";
import styles from "./WatcherEditor.module.css";

/**
 * Create a watcher ON the ChartStudio — the CREATE mirror of WatcherEditor,
 * hosted in the watch list's PUSH PANEL rather than the modal it used to be
 * (WatchModal). It shares the editor's surface and chrome to the letter: the same
 * one-bar reading chart, the same red threshold markLine painted through the
 * studio's `overlay` seam (reused straight from the editor), the same config
 * header (question, direction, threshold, cadence, live summary), and a footer
 * action aligned under the query's Run.
 *
 * It differs from WatcherEditor exactly where a create must:
 *
 * NO WATCHER TO LOAD. Nothing exists yet, so there is no stored SQL to preview on
 * mount — the panel opens instantly on the starter query below, and the chart is
 * an empty stage until the author writes the real query and Runs it. A create
 * with no reading yet is honest, not an error.
 *
 * NO DELETE, ONE PRIMARY ACTION. There is nothing to remove and nothing to
 * confirm, so the footer carries a single "Create watcher" where the editor
 * carries Delete + Save, and this host mounts no confirmation modal. The button
 * sits to the right, aligned under Run, the way the editor's Save does.
 *
 * CREATE, NOT UPDATE. Success calls actions.create (the same write WatchModal
 * called) and closes the panel; createWatcherFrom revalidates /watch, so the list
 * behind re-renders with the new watcher — this host asks for no manual refresh.
 * createWatcherCore already takes the first reading on create, so there is nothing
 * to re-run here.
 */

/**
 * The starter query the studio opens on. The studio only draws its SQL box (and
 * Run) when the spec carries a query, so a create panel has to seed *something* —
 * an empty spec would open a chartless shell with nowhere to type. A watcher
 * reduces its query to a single number, so the template selects one; it is a
 * template, not a runnable statement — the author swaps db.table for the real
 * source, Runs to preview, then Creates. Dataset-agnostic by construction.
 */
const STARTER_SQL = "select count(*)\nfrom db.table";

export function WatcherCreator({
  actions,
  onClose,
}: {
  actions: WatchActions;
  /** Close the panel. Wired to the list's panel state. */
  onClose: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [direction, setDirection] = useState<WatcherDirection>("drops_below");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [schedule, setSchedule] = useState<string>("1h");
  const [notifyEmail, setNotifyEmail] = useState("");
  // The global default, shown as the placeholder — where an alert lands when
  // this watcher names no recipient. Loaded on mount, best-effort.
  const [defaultEmail, setDefaultEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startCreate] = useTransition();
  const [schema, setSchema] = useState<
    Record<string, Record<string, string[]>> | undefined
  >();

  // The metric name the single reading bar carries. Derived from the live
  // question so the author sees it labelled as they type; a create has no stored
  // question to hold it stable against, and re-labelling one bar is free.
  const metricLabel = question.trim() || "reading";

  // The autocomplete namespace: loaded once per mount, optional. The panel opens
  // fine without it, so a failure is swallowed by the action.
  useEffect(() => {
    let live = true;
    void getWatchEditorSchemaAction().then((ns) => {
      if (live) setSchema(ns);
    });
    void getDefaultNotifyEmailAction().then((email) => {
      if (live) setDefaultEmail(email);
    });
    return () => {
      live = false;
    };
  }, []);

  // Turn a run's rows into the single reading bar — the same shaping the editor
  // does, so a create and an edit draw the reading identically.
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

  /**
   * A minimal spec whose only job is to carry the starter SQL into the studio.
   * The title is fixed rather than bound to the live question: the studio re-inits
   * on any spec change, and churning it on every keystroke would clear the
   * threshold markLine and reset the coverage check for nothing. Empty channels
   * and no data mean the studio opens on an empty table until the first Run.
   */
  const seedSpec = useMemo<ChartSpec>(
    () => ({
      chartType: "Bar Chart",
      title: "New watcher",
      encodings: { x: CATEGORY_KEY, y: VALUE_KEY },
      data: [],
      sql: STARTER_SQL,
    }),
    [],
  );

  const parsed = Number(value);
  const hasValue = value.trim() !== "" && Number.isFinite(parsed);
  // A '% change' threshold is a delta off a baseline, not a level on the reading
  // axis, so there is no honest horizontal line to draw for it — same rule the
  // editor draws the line by.
  const drawThreshold = hasValue && direction !== "changes_by";
  const thresholdText = hasValue
    ? formatThresholdValue(parsed, unit || undefined)
    : "";

  const create = (draftSql: string) => {
    const finalQuestion = question.trim();
    const finalSql = draftSql.trim();
    if (!finalQuestion) return setError("Give the watcher a question to stand for.");
    if (!finalSql) return setError("A watcher needs SQL to re-run.");
    if (!hasValue) return setError("The threshold must be a number.");

    setError(null);
    startCreate(async () => {
      const result = await actions.create({
        question: finalQuestion,
        sql: finalSql,
        schedule,
        direction,
        value: parsed,
        unit: unit || undefined,
        notifyEmail: notifyEmail.trim(),
      });
      if (result.ok) onClose();
      else setError(result.error);
    });
  };

  const label = question.trim() || "this metric";
  const rule = `${
    DIRECTIONS.find((d) => d.value === direction)?.label ?? direction
  } ${hasValue ? formatThresholdValue(parsed, unit || undefined) : "…"}`;

  return (
    <ChartStudio
      spec={seedSpec}
      onRun={async (sql) => asReadingResult(await runWatcherDraftAction(sql))}
      {...(schema ? { schema } : {})}
      resolveMaxDate={getWatchEditorMaxDateAction}
      actions={(slot: StudioSlot) => (
        // The panel draws no close of its own (showClose={false}); the studio
        // toolbar carries it, matching the watcher editor and the chat's workspace.
        <button
          type="button"
          className={slot.buttonClass}
          onClick={onClose}
          aria-label="Close the watcher creator"
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
                <label className="sr-only" htmlFor="watch-create-unit">
                  Unit
                </label>
                <select
                  id="watch-create-unit"
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

                <label className="sr-only" htmlFor="watch-create-value">
                  Threshold value
                </label>
                <input
                  id="watch-create-value"
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

          <label className={`${styles.field} ${styles.grow}`}>
            <span className={styles.eyebrow}>Notification email</span>
            <input
              className={styles.input}
              type="email"
              inputMode="email"
              value={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.value)}
              placeholder={
                defaultEmail
                  ? `Default: ${defaultEmail}`
                  : "Where alerts for this watcher are emailed"
              }
              autoComplete="off"
            />
          </label>

          <p className={styles.summary}>
            <span className={styles.arrow} aria-hidden="true">
              →
            </span>{" "}
            Alert when <strong>{label}</strong> <strong>{rule}</strong>, checked{" "}
            {cadencePhrase(schedule)}. Runs in the background via trigger.dev; chat
            is unaffected.
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

          {/* One primary action, at the foot under the query, aligned under Run
              the way the editor's Save is. No Delete (nothing exists yet) and no
              Cancel — the studio toolbar's ✕ already closes the panel. */}
          <div className={styles.actionRow}>
            <div className={styles.spacer} />
            <Button
              variant="primary"
              onClick={() => create(slot.draft)}
              disabled={pending}
            >
              {pending ? "Creating…" : "Create watcher"}
            </Button>
          </div>
        </div>
      )}
    />
  );
}

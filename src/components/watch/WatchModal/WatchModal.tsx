"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Reading } from "../Reading/Reading";
import {
  CADENCES,
  DIRECTIONS,
  UNITS,
  asOfLabel,
  cadencePhrase,
  formatReading,
  formatThresholdValue,
  type WatchActions,
  type WatchMetric,
} from "../model";
import type { WatcherDirection } from "@/types/db";
import styles from "./WatchModal.module.css";

/**
 * Threshold configuration — metric, comparator, value, cadence.
 *
 * Two ways in. From a chart in a thread, `metric` arrives already bound and the
 * modal only asks for the rule. From the Watchers page there is nothing bound,
 * so it asks for the question and the SQL too — there is no default metric,
 * because there is no default table.
 *
 * Keyboard: ui/Modal owns the focus trap, ESC and focus restore. Everything
 * below is a real form control — the segmented pickers are radio groups, so
 * arrow keys move between segments and the browser handles the roving tabstop.
 * Nothing here is a div pretending to be a button.
 */
export function WatchModal({
  open,
  onClose,
  actions,
  metric,
}: {
  open: boolean;
  onClose: () => void;
  actions: WatchActions;
  /** Omitted on the Watchers page — the modal then collects the metric itself. */
  metric?: WatchMetric;
}) {
  const formId = useId();
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const [question, setQuestion] = useState("");
  const [sql, setSql] = useState("");
  const [direction, setDirection] = useState<WatcherDirection>("drops_below");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [schedule, setSchedule] = useState<string>("1h");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A modal that remembers last time's half-finished draft is a bug, not a
  // feature: this component stays mounted while `open` flips.
  useEffect(() => {
    if (!open) return;
    setQuestion("");
    setSql("");
    setDirection("drops_below");
    setValue("");
    setUnit(metric?.unit ?? "");
    setSchedule("1h");
    setError(null);
  }, [open, metric]);

  const effectiveUnit = metric?.unit ?? unit;
  const parsed = Number(value);
  const hasValue = value.trim() !== "" && Number.isFinite(parsed);

  const label = metric ? metric.label : question.trim() || "this metric";
  // formatThresholdValue, not formatReading: this echoes back the number the
  // user just typed, so "20" must not come back at them as "20.0".
  const rule = `${
    DIRECTIONS.find((d) => d.value === direction)?.label ?? direction
  } ${hasValue ? formatThresholdValue(parsed, effectiveUnit) : "…"}`;

  function submit(event: React.FormEvent) {
    event.preventDefault();

    const finalQuestion = metric ? metric.label : question.trim();
    const finalSql = metric ? metric.sql : sql.trim();

    if (!finalQuestion) return setError("Give the watcher a question to stand for.");
    if (!finalSql) return setError("A watcher needs SQL to re-run.");
    if (!hasValue) return setError("The threshold must be a number.");

    setError(null);
    startTransition(async () => {
      const result = await actions.create({
        question: finalQuestion,
        sql: finalSql,
        schedule,
        direction,
        value: parsed,
        unit: effectiveUnit || undefined,
      });
      if (result.ok) onClose();
      else setError(result.error);
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New watcher"
      icon="◉"
      initialFocusRef={firstFieldRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          {/* In the footer, outside <form> — `form=` is what still wires it up. */}
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={pending}
            className="ml-auto"
          >
            {pending ? "Creating…" : "Create watcher"}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={submit}>
        {metric ? (
          <>
            <div className={styles.bound}>
              <span className={styles.boundLabel}>
                Watching · <strong>{metric.label}</strong>
              </span>
            </div>
            {/* The reading we have is a snapshot taken when this opened —
                nothing is re-running yet. Saying LIVING here would be a lie
                the user would set their threshold against. */}
            <Reading
              mode="frozen"
              value={formatReading(metric.current, metric.unit)}
              stamp={asOfLabel(metric.observedAt)}
            />
          </>
        ) : (
          <>
            <Field label="Question" hint="What this watcher stands for.">
              <input
                ref={firstFieldRef}
                className={styles.input}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. Average card tip, weekdays"
                autoComplete="off"
                required
              />
            </Field>

            <Field
              label="SQL"
              hint="Re-run on every check. Must return a single number."
            >
              <textarea
                className={`${styles.input} ${styles.sql}`}
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                placeholder="select avg(…) from …"
                rows={3}
                spellCheck={false}
                required
              />
            </Field>
          </>
        )}

        <div className={styles.field}>
          <span className={styles.eyebrow}>Alert me when it…</span>
          <SegmentedControl
            aria-label="Alert me when it…"
            options={[...DIRECTIONS]}
            value={direction}
            onChange={setDirection}
          />
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.eyebrow}>Threshold</legend>
          <div className={styles.threshold}>
            {!metric ? (
              <>
                <label className="sr-only" htmlFor={`${formId}-unit`}>
                  Unit
                </label>
                <select
                  id={`${formId}-unit`}
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
              </>
            ) : effectiveUnit ? (
              <span className={styles.unitFixed} aria-hidden="true">
                {effectiveUnit}
              </span>
            ) : null}

            <label className="sr-only" htmlFor={`${formId}-value`}>
              Threshold value
            </label>
            <input
              id={`${formId}-value`}
              // type=number brings its own steppers and keyboard handling —
              // the design drew ▲▼ and this is where they come from for free.
              type="number"
              step="any"
              inputMode="decimal"
              className={`tnum ${styles.number}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0"
              ref={metric ? firstFieldRef : undefined}
              required
            />

            {direction === "changes_by" ? (
              <span className={styles.baseline}>vs 4-week average</span>
            ) : null}
          </div>

          {metric && metric.current !== null && hasValue ? (
            <p className={`tnum ${styles.hint}`}>
              Baseline right now is {formatReading(metric.current, metric.unit)}
              {/* The trip estimate is only arithmetic we can do when the
                  threshold is a *percentage* change of the baseline. With a
                  "changes by $2" rule the trip point is the baseline ± 2, and
                  with a non-% unit on a rises/drops rule the threshold already
                  IS the trip point — so there is nothing to estimate. */}
              {direction === "changes_by" && effectiveUnit === "%"
                ? ` · a ${formatThresholdValue(parsed, "%")} change would trip at ≈ ${formatReading(
                    metric.current * (1 + parsed / 100),
                    metric.unit,
                  )}.`
                : "."}
            </p>
          ) : null}
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

        <p className={styles.summary}>
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>{" "}
          Alert when <strong>{label}</strong> <strong>{rule}</strong>, checked{" "}
          {cadencePhrase(schedule)}. Runs in the background via trigger.dev; chat
          is unaffected.
        </p>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

/** A labelled control with an optional line of guidance under the label. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.eyebrow}>{label}</span>
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
      {children}
    </label>
  );
}

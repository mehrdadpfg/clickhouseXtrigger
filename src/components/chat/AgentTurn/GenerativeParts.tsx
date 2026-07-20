"use client";

import { useState, type CSSProperties } from "react";
import { useThreadRuntime } from "@assistant-ui/react";
import {
  ArrowRight,
  BellRing,
  Clock,
  CornerDownRight,
  PencilLine,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Card } from "@/components/ui";
import { cadencePhrase } from "@/components/watch/model";
import { markUiAction } from "../uiAction";
import styles from "./GenerativeParts.module.css";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const DIRECTION_LABEL: Record<string, string> = {
  rises_above: "rises above",
  drops_below: "drops below",
  changes_by: "changes by",
};

// --- Watcher created -------------------------------------------------------

type WatcherMode = "created" | "updated" | "deleted";

interface WatcherView {
  ok: boolean;
  mode: WatcherMode;
  question: string;
  schedule?: string;
  direction?: string;
  value?: number;
  unit?: string;
  state?: string;
  error?: string;
}

/** Read a createWatcher/editWatcher/deleteWatcher result (or its echoed args). */
export function readWatcher(args: unknown, result: unknown): WatcherView | null {
  const src = isRecord(result) ? result : isRecord(args) ? args : null;
  if (!src) return null;
  const ok = src["ok"] !== false;
  const mode: WatcherMode = src["deleted"]
    ? "deleted"
    : src["updated"]
      ? "updated"
      : "created";
  const question = str(src["question"]) || str(isRecord(args) ? args["question"] : "");
  if (!ok) {
    const verb = mode === "deleted" ? "delete" : mode === "updated" ? "update" : "create";
    return { ok: false, mode, question, error: str(src["error"]) || `Could not ${verb} the watcher.` };
  }
  if (mode === "deleted") return { ok: true, mode, question };
  if (!question) return null;
  const v = num(src["value"]);
  return {
    ok: true,
    mode,
    question,
    schedule: str(src["schedule"]) || undefined,
    direction: str(src["direction"]) || undefined,
    ...(v !== null ? { value: v } : {}),
    unit: str(src["unit"]) || undefined,
    state: str(src["state"]) || undefined,
  };
}

const MODE_TITLE: Record<WatcherMode, string> = {
  created: "Watcher created",
  updated: "Watcher updated",
  deleted: "Watcher removed",
};

/** The watcher create/update/delete confirmation, rendered inline in the answer. */
export function WatcherCard({ view }: { view: WatcherView }) {
  if (!view.ok) {
    return (
      <Card tone="critical" className={styles.watcher}>
        <div className={styles.watcherHead}>
          <span className={`${styles.watcherIcon} ${styles.iconBad}`}>
            <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />
          </span>
          <span className={styles.watcherTitle}>
            Couldn&apos;t {view.mode === "deleted" ? "delete" : view.mode === "updated" ? "update" : "create"} watcher
          </span>
        </div>
        <p className={styles.watcherError}>{view.error}</p>
      </Card>
    );
  }

  // Removed: a muted receipt — the watcher is gone, so no meta, no link.
  if (view.mode === "deleted") {
    return (
      <Card className={styles.watcher}>
        <div className={styles.watcherHead}>
          <span className={`${styles.watcherIcon} ${styles.iconMuted}`}>
            <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
          </span>
          <span className={styles.watcherTitle}>{MODE_TITLE.deleted}</span>
        </div>
        {view.question ? (
          <p className={`${styles.watcherQuestion} ${styles.watcherStruck}`}>{view.question}</p>
        ) : null}
      </Card>
    );
  }

  const dir = view.direction ? (DIRECTION_LABEL[view.direction] ?? view.direction) : null;
  const threshold =
    dir && view.value !== undefined
      ? `alerts when it ${dir} ${view.value}${view.unit ?? ""}`
      : null;
  const Icon = view.mode === "updated" ? PencilLine : BellRing;

  return (
    <Card tone="accent" className={styles.watcher}>
      <div className={styles.watcherHead}>
        <span className={styles.watcherIcon}>
          <Icon size={15} strokeWidth={2} aria-hidden="true" />
        </span>
        <span className={styles.watcherTitle}>{MODE_TITLE[view.mode]}</span>
        <a href="/watch" className={styles.watcherLink}>
          View in Watchers
          <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
        </a>
      </div>
      <p className={styles.watcherQuestion}>{view.question}</p>
      <div className={styles.watcherMeta}>
        {view.state === "paused" ? (
          <span className={`${styles.metaChip} ${styles.metaPaused}`}>paused</span>
        ) : null}
        {view.schedule ? (
          <span className={styles.metaChip}>
            <Clock size={12} strokeWidth={2} aria-hidden="true" />
            {cadencePhrase(view.schedule)}
          </span>
        ) : null}
        {threshold ? <span className={styles.metaChip}>{threshold}</span> : null}
      </div>
    </Card>
  );
}

// --- Present choices -------------------------------------------------------

interface Choice {
  label: string;
  value: string;
  hint?: string;
}

interface ChoiceView {
  question: string;
  options: Choice[];
}

export function readChoices(args: unknown): ChoiceView | null {
  if (!isRecord(args)) return null;
  const question = str(args["question"]);
  const raw = Array.isArray(args["options"]) ? args["options"] : [];
  const options: Choice[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const label = str(item["label"]);
    const value = str(item["value"]);
    if (label && value) {
      options.push({ label, value, ...(str(item["hint"]) ? { hint: str(item["hint"]) } : {}) });
    }
  }
  if (!question || options.length === 0) return null;
  return { question, options };
}

/**
 * A labelled list the user picks from when the agent needs disambiguation.
 * Clicking sends the option's `value` as the next user message, so the thread
 * continues where the choice left off. Picks once, then locks.
 */
export function ChoiceCard({ view }: { view: ChoiceView }) {
  const thread = useThreadRuntime();
  const [picked, setPicked] = useState<string | null>(null);

  const choose = (option: Choice) => {
    if (picked) return;
    setPicked(option.value);
    thread.append(markUiAction(option.label, option.value));
  };

  return (
    <Card className={styles.choices}>
      <p className={styles.choiceQuestion}>{view.question}</p>
      <div className={styles.choiceList}>
        {view.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`${styles.choice} ${picked === option.value ? styles.choicePicked : ""}`}
            disabled={picked !== null}
            onClick={() => choose(option)}
          >
            <CornerDownRight
              size={14}
              strokeWidth={2}
              aria-hidden="true"
              className={styles.choiceGlyph}
            />
            <span className={styles.choiceText}>
              <span className={styles.choiceLabel}>{option.label}</span>
              {option.hint ? <span className={styles.choiceHint}>{option.hint}</span> : null}
            </span>
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" className={styles.choiceArrow} />
          </button>
        ))}
      </div>
    </Card>
  );
}

// --- Ask for a threshold ---------------------------------------------------

/**
 * The three directions, each with its own hue and glyph.
 *
 * Hues come from the series ramp, NOT the status tokens: --good / --critical
 * are reserved for state, and they would assert a judgement the data can't
 * support — a rising number is good news for revenue and bad news for evictions.
 * Direction is what the chip means, so direction is all it says.
 *
 * The arrow carries the meaning on its own, so the colour is never the only
 * signal — which is also what keeps the selected chip readable to anyone who
 * can't separate the three hues.
 */
const DIRECTIONS: { key: string; label: string; glyph: string; hue: string }[] = [
  { key: "rises_above", label: "rises above", glyph: "\u2191", hue: "var(--series-1)" },
  { key: "drops_below", label: "drops below", glyph: "\u2193", hue: "var(--series-5)" },
  { key: "changes_by", label: "changes by", glyph: "\u21c5", hue: "var(--series-3)" },
];

const SCHEDULES = ["5m", "1h", "6h", "daily"];

interface ThresholdView {
  metric: string;
  sql: string;
  currentValue: number | null;
  unit: string;
  direction: string;
  value: number;
  schedule: string;
}

export function readThreshold(args: unknown): ThresholdView | null {
  if (!isRecord(args)) return null;
  const metric = str(args["metric"]);
  const sql = str(args["sql"]);
  const value = num(args["suggestedValue"]);
  if (!metric || !sql || value === null) return null;
  const direction = str(args["suggestedDirection"]) || "rises_above";
  return {
    metric,
    sql,
    currentValue: num(args["currentValue"]),
    unit: str(args["unit"]),
    direction: DIRECTIONS.some((d) => d.key === direction) ? direction : "rises_above",
    value,
    schedule: SCHEDULES.includes(str(args["suggestedSchedule"]))
      ? str(args["suggestedSchedule"])
      : "daily",
  };
}

/**
 * The threshold form — direction, number, cadence — for when the metric is
 * settled and only the number is missing.
 *
 * A threshold isn't a disambiguation, so ChoiceCard is the wrong shape for it:
 * three fields can't be a list of canned combinations, and a reader can't judge
 * "rises above 20,000" without seeing what the metric reads today. So the agent
 * runs the metric first and seeds this from the live number.
 *
 * Submitting sends the filled spec as the next message — marked as a UI action,
 * so the thread shows a chip rather than a sentence of parameters — and the
 * agent hands it to createWatcher. Submits once, then locks.
 */
export function ThresholdCard({ view }: { view: ThresholdView }) {
  const thread = useThreadRuntime();
  const [direction, setDirection] = useState(view.direction);
  const [value, setValue] = useState(String(view.value));
  const [schedule, setSchedule] = useState(view.schedule);
  const [sent, setSent] = useState(false);

  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed);

  const submit = () => {
    if (sent || !valid) return;
    setSent(true);
    const label = DIRECTIONS.find((d) => d.key === direction)?.label ?? direction;
    thread.append(
      markUiAction(
        `${label} ${value}${view.unit}`,
        `Create the watcher now: metric "${view.metric}", direction ${direction}, ` +
          `value ${parsed}${view.unit ? `, unit ${view.unit}` : ""}, schedule ${schedule}. ` +
          `Use this SQL exactly: ${view.sql}`,
      ),
    );
  };

  return (
    <Card className={styles.threshold}>
      <p className={styles.thresholdMetric}>{view.metric}</p>
      {view.currentValue !== null ? (
        <p className={styles.thresholdNow}>
          reads <strong>{view.currentValue.toLocaleString()}{view.unit}</strong> right now
        </p>
      ) : null}

      <div className={styles.thresholdRow}>
        {DIRECTIONS.map((d) => (
          <button
            key={d.key}
            type="button"
            disabled={sent}
            className={`${styles.thresholdPick} ${direction === d.key ? styles.thresholdPickOn : ""}`}
            style={direction === d.key ? { "--pick-hue": d.hue } as CSSProperties : undefined}
            onClick={() => setDirection(d.key)}
          >
            <span aria-hidden="true" className={styles.thresholdGlyph}>
              {d.glyph}
            </span>
            {d.label}
          </button>
        ))}
      </div>

      <div className={styles.thresholdRow}>
        <input
          className={styles.thresholdInput}
          value={value}
          disabled={sent}
          inputMode="decimal"
          aria-label="Threshold value"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {view.unit ? <span className={styles.thresholdUnit}>{view.unit}</span> : null}
      </div>

      <div className={styles.thresholdRow}>
        <span className={styles.thresholdLabel}>check</span>
        {SCHEDULES.map((s) => (
          <button
            key={s}
            type="button"
            disabled={sent}
            className={`${styles.thresholdPick} ${schedule === s ? styles.thresholdPickOn : ""}`}
            onClick={() => setSchedule(s)}
          >
            {cadencePhrase(s)}
          </button>
        ))}
      </div>

      <div className={styles.thresholdFoot}>
        <button
          type="button"
          className={styles.thresholdSubmit}
          disabled={sent || !valid}
          onClick={submit}
        >
          {sent ? "Creating…" : "Create watcher"}
        </button>
      </div>
    </Card>
  );
}

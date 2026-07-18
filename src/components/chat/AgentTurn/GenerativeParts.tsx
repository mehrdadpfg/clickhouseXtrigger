"use client";

import { useState } from "react";
import { useThreadRuntime } from "@assistant-ui/react";
import {
  ArrowRight,
  BellRing,
  Clock,
  CornerDownRight,
  TriangleAlert,
} from "lucide-react";
import { Card } from "@/components/ui";
import { cadencePhrase } from "@/components/watch/model";
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

interface WatcherView {
  ok: boolean;
  question: string;
  schedule?: string;
  direction?: string;
  value?: number;
  unit?: string;
  error?: string;
}

/** Read the createWatcher tool's result (preferred) or its echoed args. */
export function readWatcher(args: unknown, result: unknown): WatcherView | null {
  const src = isRecord(result) ? result : isRecord(args) ? args : null;
  if (!src) return null;
  const ok = src["ok"] !== false;
  const question = str(src["question"]) || str(isRecord(args) ? args["question"] : "");
  if (!ok) {
    return { ok: false, question, error: str(src["error"]) || "Could not create the watcher." };
  }
  if (!question) return null;
  const v = num(src["value"]);
  return {
    ok: true,
    question,
    schedule: str(src["schedule"]) || undefined,
    direction: str(src["direction"]) || undefined,
    ...(v !== null ? { value: v } : {}),
    unit: str(src["unit"]) || undefined,
  };
}

/** The "watcher created" confirmation, rendered inline in the answer. */
export function WatcherCard({ view }: { view: WatcherView }) {
  if (!view.ok) {
    return (
      <Card tone="critical" className={styles.watcher}>
        <div className={styles.watcherHead}>
          <span className={`${styles.watcherIcon} ${styles.iconBad}`}>
            <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />
          </span>
          <span className={styles.watcherTitle}>Couldn&apos;t create watcher</span>
        </div>
        <p className={styles.watcherError}>{view.error}</p>
      </Card>
    );
  }

  const dir = view.direction ? (DIRECTION_LABEL[view.direction] ?? view.direction) : null;
  const threshold =
    dir && view.value !== undefined
      ? `alerts when it ${dir} ${view.value}${view.unit ?? ""}`
      : null;

  return (
    <Card tone="accent" className={styles.watcher}>
      <div className={styles.watcherHead}>
        <span className={styles.watcherIcon}>
          <BellRing size={15} strokeWidth={2} aria-hidden="true" />
        </span>
        <span className={styles.watcherTitle}>Watcher created</span>
        <a href="/watch" className={styles.watcherLink}>
          View in Watchers
          <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
        </a>
      </div>
      <p className={styles.watcherQuestion}>{view.question}</p>
      <div className={styles.watcherMeta}>
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
    thread.append(option.value);
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

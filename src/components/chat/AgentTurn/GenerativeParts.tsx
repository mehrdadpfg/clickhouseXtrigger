"use client";

import { useState } from "react";
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

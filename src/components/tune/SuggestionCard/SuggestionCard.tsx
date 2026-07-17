"use client";

import { SqlBlock } from "@/components/ui/SqlBlock";
import { Button } from "@/components/ui/Button";
import {
  kindLabel,
  type SuggestionStatus,
  type SuggestionView,
} from "../model";
import styles from "./SuggestionCard.module.css";

export interface SuggestionCardProps {
  suggestion: SuggestionView;
  /** Approve (true) or dismiss (false). Rejected promises surface as an error line. */
  onDecide: (approved: boolean) => void;
  /** A decision is in flight for this card. */
  busy?: boolean;
}

/** The status pill in the header — reserved status colour, always with a word. */
const STATUS_LABEL: Record<SuggestionStatus, string> = {
  pending: "Pending approval",
  applied: "Applied",
  failed: "Failed",
  dismissed: "Dismissed",
};

const STATUS_ICON: Record<SuggestionStatus, string> = {
  pending: "◷",
  applied: "✓",
  failed: "⚠",
  dismissed: "○",
};

export function SuggestionCard({
  suggestion,
  onDecide,
  busy = false,
}: SuggestionCardProps) {
  const { kind, name, title, rationale, status } = suggestion;
  const pending = status === "pending";

  return (
    <div className={[styles.card, styles[status]].join(" ")}>
      <div className={styles.head}>
        <div className={styles.tagRow}>
          <span
            className={[styles.kind, styles[kind]].join(" ")}
            title={kindLabel(kind)}
          >
            {kindLabel(kind)}
          </span>
          <span className={[styles.status, styles[`s_${status}`]].join(" ")}>
            <span aria-hidden="true">{STATUS_ICON[status]}</span>
            {STATUS_LABEL[status]}
          </span>
          <span className={styles.speedup}>{suggestion.estSpeedup}</span>
        </div>

        <div className={styles.name}>{name}</div>
        <div className={styles.rationale}>{title !== name ? title : rationale}</div>
        {title !== name ? (
          <div className={styles.rationaleSub}>{rationale}</div>
        ) : null}
      </div>

      <div className={styles.meta}>
        <span className={styles.metaText}>
          covers {suggestion.questionsCovered} question
          {suggestion.questionsCovered === 1 ? "" : "s"} · {suggestion.estStorage}{" "}
          · on {suggestion.targetTable}
        </span>
      </div>

      {suggestion.error ? (
        <div className={styles.error} role="alert">
          {suggestion.error}
        </div>
      ) : null}

      {pending ? (
        <div className={styles.actions}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => onDecide(true)}
            disabled={busy}
          >
            {busy ? "Working…" : "Approve & create"}
          </Button>
          <Button size="sm" onClick={() => onDecide(false)} disabled={busy}>
            Dismiss
          </Button>
        </div>
      ) : null}

      <SqlBlock
        sql={suggestion.sql}
        summary={`SQL — ${kindLabel(kind).toLowerCase()}`}
        className={styles.sql}
      />
    </div>
  );
}

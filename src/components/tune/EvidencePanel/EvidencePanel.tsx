"use client";

import {
  formatCount,
  formatDuration,
  formatRows,
  type EvidenceView,
} from "../model";
import styles from "./EvidencePanel.module.css";

export interface EvidencePanelProps {
  evidence: EvidenceView[];
  windowDays: number;
}

/**
 * "From your history" — the real query-log patterns the suggestions were drawn
 * from. This is the "what informed this": every row is a normalized_query_hash
 * with its true recurrence and cost, so a suggestion can always be traced back
 * to work that actually happened.
 */
export function EvidencePanel({ evidence, windowDays }: EvidencePanelProps) {
  return (
    <div>
      <div className={styles.heading}>From your history</div>

      {evidence.length === 0 ? (
        <div className={styles.empty}>
          No recurring queries against your tables in the last {windowDays} days.
        </div>
      ) : (
        <div className={styles.panel}>
          {evidence.map((row) => (
            <div key={row.queryHash} className={styles.row} title={row.sql}>
              <div className={styles.top}>
                <span className={styles.label}>{row.label}</span>
                <span className={styles.count}>{formatCount(row.count)}</span>
              </div>
              <div
                className={[
                  styles.stat,
                  row.materialized ? styles.materialized : "",
                ].join(" ")}
              >
                avg {formatDuration(row.avgDurationMs)} ·{" "}
                {row.materialized
                  ? "materialized"
                  : `${formatRows(row.totalReadRows)} scanned`}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className={styles.note}>
        Re-run analysis after you approve changes to see the new baseline.
      </p>
    </div>
  );
}

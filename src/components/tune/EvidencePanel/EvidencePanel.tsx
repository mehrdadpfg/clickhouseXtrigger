"use client";

import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  formatCount,
  formatDuration,
  formatRows,
  type EvidenceView,
} from "../model";

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
      <div className="mb-[11px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
        From your history
      </div>

      {evidence.length === 0 ? (
        <Card className="text-[12.5px] leading-[1.5] text-muted-foreground">
          No repeated queries in the log’s retained window.
        </Card>
      ) : (
        <Card padding="none" className="px-1 py-1.5">
          {evidence.map((row) => (
            <div
              key={row.queryHash}
              title={row.sql}
              className="cursor-default rounded-[var(--r-lg)] px-3 py-2.5 hover:bg-[var(--raised)]"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-[var(--text)]">
                  {row.label}
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatCount(row.count)}
                </span>
              </div>
              <div className="mt-[3px] font-mono text-[10px] tabular-nums text-[var(--text-faint)]">
                avg {formatDuration(row.avgDurationMs)} ·{" "}
                {formatRows(row.totalReadRows)} scanned
              </div>
            </div>
          ))}
        </Card>
      )}

      <p className="mt-3 px-0.5 font-mono text-[10.5px] leading-[1.55] text-[var(--text-faint)]">
        Re-run analysis after you approve changes to see the new baseline.
      </p>
    </div>
  );
}

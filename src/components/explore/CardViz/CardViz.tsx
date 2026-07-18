"use client";

import {
  EChart,
  optionFromSpec,
  resolveChartSpec,
  StatTile,
} from "@/components/ui";
import { toKpi } from "@/components/boards";
import type { ResultRow } from "@/lib/discover/model";
import styles from "../FindingCard/FindingCard.module.css";

/**
 * The figure on a card — a finding's or a walk step's.
 *
 * Renders from embedded rows (never SQL): the agent's chart type is honoured via
 * resolveChartSpec (a pie stays a pie), a single number falls back to a stat, and
 * a query that failed says so. Shared by FindingCard and WalkCard so both draw the
 * same way.
 */
export function CardViz({
  rows,
  error,
  chartType,
  encodings,
  title,
}: {
  rows: ResultRow[];
  error: string | null;
  chartType?: string;
  encodings?: Record<string, string>;
  title: string;
}) {
  if (error) {
    return (
      <p className={styles.vizError} role="alert">
        couldn&rsquo;t run: {error}
      </p>
    );
  }
  if (!rows || rows.length === 0) {
    return <p className={styles.muted}>No rows.</p>;
  }

  const spec = resolveChartSpec(rows, title, chartType, encodings);
  const option = spec ? optionFromSpec(spec) : null;
  if (option) return <EChart option={option} height={150} />;

  const kpi = toKpi(rows, {}, title);
  if (kpi) return <StatTile value={kpi.value} />;

  return <p className={styles.muted}>—</p>;
}

"use client";

import { useMemo } from "react";
import type { ChartSpec, DataRow } from "@/components/ui";
import styles from "./ChartWorkspace.module.css";

/**
 * A read of the rows currently on the stage — rows, and the spread of whatever
 * the chart's y channel is.
 *
 * Derived from the rows already in hand, never from a second query: the point
 * is to say something about the data you are looking at without making the
 * workspace slower to open. A chart with no numeric measure (a treemap of
 * labels, say) simply shows the count and stops, rather than inventing a
 * statistic to fill the strip.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const EXACT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Big numbers compact so the strip never wraps; small ones stay readable. */
function fmt(n: number): string {
  return Math.abs(n) >= 100_000 ? COMPACT.format(n) : EXACT.format(n);
}

export function Indicators({
  spec,
  rows,
}: {
  spec: ChartSpec;
  rows: DataRow[];
}) {
  const stats = useMemo(() => {
    // The measure is whatever the chart puts on y — or size, for the
    // part-to-whole family, which has no y at all.
    const field = spec.encodings["y"] ?? spec.encodings["size"];
    if (!field) return null;

    const values = rows
      .map((r) => asNumber(r[field]))
      .filter((v): v is number => v !== null);
    if (values.length === 0) return null;

    const total = values.reduce((a, b) => a + b, 0);
    const first = values[0]!;
    const last = values[values.length - 1]!;
    return {
      field,
      total,
      min: Math.min(...values),
      max: Math.max(...values),
      mean: total / values.length,
      // Only meaningful when the x axis is ordered — a first-to-last change on
      // a ranked bar chart would be the gap between rank 1 and rank N, which is
      // not a "change" at all. Time is the ordered case.
      delta: isTemporal(spec, rows) && values.length > 1 && first !== 0
        ? ((last - first) / Math.abs(first)) * 100
        : null,
    };
  }, [spec, rows]);

  if (!stats) {
    return (
      <div className={styles.indicators}>
        <Stat label="rows" value={String(rows.length)} />
      </div>
    );
  }

  return (
    <div className={styles.indicators}>
      <Stat label="rows" value={String(rows.length)} />
      <Stat label={`total ${stats.field}`} value={fmt(stats.total)} />
      <Stat label="min" value={fmt(stats.min)} />
      <Stat label="max" value={fmt(stats.max)} />
      <Stat label="mean" value={fmt(stats.mean)} />
      {stats.delta !== null ? (
        <Stat
          label="first → last"
          value={`${stats.delta > 0 ? "+" : ""}${stats.delta.toFixed(1)}%`}
          tone={stats.delta > 0 ? "up" : stats.delta < 0 ? "down" : undefined}
        />
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <div className={styles.indicator}>
      <span className={styles.indicatorLabel}>{label}</span>
      <span
        className={`${styles.indicatorValue} ${
          tone === "up" ? styles.indicatorUp : tone === "down" ? styles.indicatorDown : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/** Does the chart's x channel read as a date/time? Drives the range chips too. */
export function isTemporal(spec: ChartSpec, rows: DataRow[]): boolean {
  const x = spec.encodings["x"];
  if (!x) return false;
  if (spec.semanticTypes?.[x] === "Time") return true;
  const sample = rows.find((r) => r[x] !== null && r[x] !== undefined)?.[x];
  if (sample instanceof Date) return true;
  if (typeof sample !== "string") return false;
  // A ClickHouse date/datetime comes back as "2023-04-01" or with a time part.
  return /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2})?/.test(sample);
}

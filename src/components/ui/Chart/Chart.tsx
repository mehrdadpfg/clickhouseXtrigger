"use client";

import { useId, useMemo, useState } from "react";
import { DataTable, type DataColumn, type DataRow } from "../DataTable";
import { BarsH } from "./BarsH";
import { Cartesian, type CartesianKind } from "./Cartesian";
import styles from "./Chart.module.css";
import { formatValue } from "./scale";
import { byCategory, categoriesOf, legendEntries, resolveSeries } from "./series";
import { useSize } from "./useSize";
import type { ChartKind, ChartProps, ChartX, ResolvedSeries } from "./types";

/**
 * Beyond this, a vertical column's label has to rotate, overlap, or be dropped —
 * all three are worse than turning the chart on its side.
 */
const LONG_LABEL = 12;

/**
 * The agent picks `kind` from the question, before it has seen a single label.
 * So "bar" means "compare these categories", and the system — which *has* seen
 * the data — decides the axis the labels can survive on. An explicit "barh" is
 * still honoured as-is; this only promotes the ambiguous case.
 */
function resolveKind(kind: ChartKind, series: ResolvedSeries[]): CartesianKind | "barh" {
  if (kind !== "bar") return kind;
  const categories = categoriesOf(series);
  if (categories.length === 0) return "bar";
  const longest = Math.max(...categories.map((c) => c.length));
  return longest > LONG_LABEL ? "barh" : "bar";
}

export function Chart({
  kind,
  series,
  title,
  x,
  y,
  height = 180,
  className,
}: ChartProps) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const { ref, width } = useSize<HTMLDivElement>();
  const titleId = useId();

  const resolved = useMemo(() => resolveSeries(series), [series]);
  const legend = useMemo(() => legendEntries(resolved), [resolved]);
  const effective = useMemo(() => resolveKind(kind, resolved), [kind, resolved]);

  const fmtY = y?.format ?? formatValue;
  const fmtX =
    x?.format ?? ((v: ChartX) => (typeof v === "number" ? formatValue(v) : String(v)));

  /* The table twin: every value the chart encodes, in text. Not a fallback —
     it is the accessible equal of the plot, and it is always reachable. */
  const table = useMemo(() => {
    const categories = categoriesOf(resolved);
    const lookups = resolved.map((s) => byCategory(s));

    // Keyed positionally: two series may share a name, and a series may be
    // called "x". Neither should be able to collide a column away.
    const columns: DataColumn[] = [
      { key: "__x", label: x?.label ?? "x", align: "left" },
      ...resolved.map((s, i) => ({
        key: `s${i}`,
        label: s.name,
        align: "right" as const,
        format: (value: unknown) =>
          typeof value === "number" ? fmtY(value) : "—",
      })),
    ];

    const rows: DataRow[] = categories.map((category) => {
      const row: DataRow = { __x: fmtX(category) };
      resolved.forEach((_, i) => {
        row[`s${i}`] = lookups[i]?.get(category) ?? null;
      });
      return row;
    });

    return { columns, rows };
  }, [resolved, x?.label, fmtX, fmtY]);

  // One series needs no legend: there is only one colour, and the title above
  // already names it. A box with a single swatch just restates the title.
  const showLegend = legend.length >= 2;

  return (
    <figure className={[styles.frame, className].filter(Boolean).join(" ")}>
      <div className={styles.header}>
        <figcaption className={styles.title} id={titleId}>
          {title}
        </figcaption>

        <div className={styles.toggle} role="group" aria-label="View as">
          {(["chart", "table"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`${styles.toggleOption} ${view === option ? styles.toggleOn : ""}`}
              aria-pressed={view === option}
              onClick={() => setView(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {showLegend && view === "chart" && (
        <div className={styles.legend}>
          {legend.map((entry) => (
            <span className={styles.legendItem} key={entry.name}>
              {/* The legend mirrors the mark: a stroke for lines, a dot for
                  scatter, a swatch for anything with a fill. */}
              <span
                className={
                  kind === "line"
                    ? styles.legendKeyLine
                    : kind === "scatter"
                      ? styles.legendKeyDot
                      : styles.legendKeyRect
                }
                style={{ background: entry.color }}
              />
              {entry.name}
            </span>
          ))}
        </div>
      )}

      <div className={styles.body} ref={ref}>
        {view === "table" ? (
          <DataTable columns={table.columns} rows={table.rows} maxHeight="320px" />
        ) : effective === "barh" ? (
          <BarsH series={resolved} x={x} y={y} />
        ) : (
          <Cartesian
            kind={effective}
            series={resolved}
            title={title}
            x={x}
            y={y}
            width={width}
            height={height}
          />
        )}
      </div>
    </figure>
  );
}

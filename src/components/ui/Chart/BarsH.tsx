"use client";

import styles from "./Chart.module.css";
import { formatValue } from "./scale";
import { byCategory, categoriesOf, yExtent } from "./series";
import type { ChartX, ChartXAxis, ChartYAxis, ResolvedSeries } from "./types";

interface BarsHProps {
  series: ResolvedSeries[];
  x?: ChartXAxis;
  y?: ChartYAxis;
}

/**
 * Horizontal bars — the form long category labels demand.
 *
 * Built from HTML rows rather than SVG on purpose: neighbourhood names need
 * ellipsis truncation, a title tooltip, and a level baseline, and CSS does all
 * three for free where SVG would need text measurement to fake them.
 *
 * The value rides its own column, so every value is on screen without hovering.
 * That makes the tooltip genuinely supplementary here — its remaining job is the
 * untruncated label and the series name, which is what `title` carries.
 */
export function BarsH({ series, x, y }: BarsHProps) {
  const categories = categoriesOf(series);
  const fmtY = y?.format ?? formatValue;
  const fmtX =
    x?.format ?? ((v: ChartX) => (typeof v === "number" ? formatValue(v) : String(v)));

  const [min, max] = yExtent(series);
  // Bar length is the value, so zero must be on the scale. Negatives get a
  // centred baseline rather than a lie about direction.
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  const span = hi - lo || 1;
  const pct = (v: number) => ((v - lo) / span) * 100;
  const zero = pct(0);

  const lookups = series.map((s) => byCategory(s));

  return (
    <div className={styles.barsH}>
      {categories.map((category) => (
        <div className={styles.barsHRow} key={category}>
          {/* Level, ellipsised, and the full string is one hover away. */}
          <span className={styles.barsHLabel} title={category}>
            {fmtX(category)}
          </span>

          <div className={styles.barsHTracks}>
            {series.map((s, si) => {
              const value = lookups[si]?.get(category) ?? null;
              if (value === null || !Number.isFinite(value)) {
                return (
                  <div className={styles.barsHTrack} key={s.name}>
                    <span className={styles.barsHRail} />
                    <span className={`tnum ${styles.barsHValue}`}>—</span>
                  </div>
                );
              }
              const v = pct(value);
              const left = Math.min(zero, v);
              const width = Math.abs(v - zero);
              return (
                <div className={styles.barsHTrack} key={s.name}>
                  <span className={styles.barsHRail}>
                    <span
                      className={styles.barsHBar}
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        background: s.color,
                      }}
                      title={
                        series.length > 1
                          ? `${s.name} · ${fmtY(value)}`
                          : `${category} · ${fmtY(value)}`
                      }
                    />
                  </span>
                  {/* Value at the tip — in its own column, so it can never be
                      clipped by a bar too short to hold it. */}
                  <span className={`tnum ${styles.barsHValue}`}>{fmtY(value)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

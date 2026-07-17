"use client";

import styles from "./Chart.module.css";

export interface TooltipRow {
  name: string;
  color: string;
  value: string;
}

export interface TooltipProps {
  /** Anchor in plot pixels — the tooltip flips itself to stay inside `width`. */
  x: number;
  y: number;
  width: number;
  head: string;
  rows: TooltipRow[];
}

const OFFSET = 14;
const EST_WIDTH = 168;

export function Tooltip({ x, y, width, head, rows }: TooltipProps) {
  // Flip to the pointer's left when a right-hand tooltip would overflow the card.
  const flip = x + OFFSET + EST_WIDTH > width;

  return (
    <div
      className={styles.tooltip}
      style={{
        left: flip ? undefined : x + OFFSET,
        right: flip ? width - x + OFFSET : undefined,
        top: y,
      }}
      // Purely a readout: it must never eat the pointer events that drive it.
      aria-hidden="true"
    >
      <div className={styles.tooltipHead}>{head}</div>
      {rows.map((row, i) => (
        <div className={styles.tooltipRow} key={`${row.name}-${i}`}>
          {/* A line key, not a filled box: at this density a box is data-weight
              ink doing a label's job. Identity lives in the mark, not the text. */}
          <span className={styles.tooltipKey} style={{ background: row.color }} />
          <span className={styles.tooltipName}>{row.name}</span>
          <span className={styles.tooltipValue}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

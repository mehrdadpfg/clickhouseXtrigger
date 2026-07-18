"use client";

import type { CSSProperties, RefObject } from "react";
import { ArrowDownToLine } from "lucide-react";
import type { EChartHandle } from "./EChart";
import styles from "./ExportMenu.module.css";

/**
 * The per-chart download control: one ⤓ button that saves the chart as a PNG,
 * on click — no menu, no format choice. Presentational: it drives the EChart
 * handle and knows nothing about where the chart came from, so the chat card and
 * a board tile share the one control.
 *
 * `buttonClassName` lets a host toolbar (the board tile header) style it like its
 * sibling actions; without it the built-in trigger is used.
 */
export function ExportMenu({
  chartRef,
  filename,
  buttonClassName,
  style,
}: {
  chartRef: RefObject<EChartHandle | null>;
  /** Download stem (already slugified). ".png" is appended. */
  filename: string;
  buttonClassName?: string;
  /** Positioning from the host (e.g. a corner of the chat card). */
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      className={buttonClassName ?? styles.trigger}
      style={style}
      aria-label="Download chart as PNG"
      title="Download PNG"
      onClick={() => chartRef.current?.exportPNG(filename)}
    >
      <ArrowDownToLine size={15} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { EChartHandle } from "./EChart";
import styles from "./ExportMenu.module.css";

/**
 * The per-chart Export control: a small ⤓ button that opens a PNG / SVG menu and
 * drives the EChart handle. Purely presentational — it knows nothing about where
 * the chart came from, so the chat card and a board tile share one control.
 *
 * `buttonClassName` lets a host toolbar (the board tile header) style the
 * trigger like its sibling actions; without it the built-in trigger is used.
 */
export function ExportMenu({
  chartRef,
  filename,
  buttonClassName,
  style,
}: {
  chartRef: RefObject<EChartHandle | null>;
  /** Download stem (already slugified). ".png" / ".svg" are appended. */
  filename: string;
  buttonClassName?: string;
  /** Positioning from the host (e.g. absolute top-right on the chat card). */
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (kind: "png" | "svg") => {
    const handle = chartRef.current;
    if (handle) {
      if (kind === "png") handle.exportPNG(filename);
      else handle.exportSVG(filename);
    }
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={styles.root} style={style}>
      <button
        type="button"
        className={buttonClassName ?? styles.trigger}
        aria-label="Export chart"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Export chart"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">⤓</span>
      </button>
      {open ? (
        <div id={menuId} role="menu" className={styles.menu}>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => run("png")}
          >
            Export <span className={styles.itemHint}>PNG</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => run("svg")}
          >
            Export <span className={styles.itemHint}>SVG</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

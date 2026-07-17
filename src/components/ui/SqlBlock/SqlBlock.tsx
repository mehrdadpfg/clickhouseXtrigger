"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import styles from "./SqlBlock.module.css";

export interface SqlBlockProps {
  /** The query text, rendered verbatim. */
  sql: string;
  /**
   * The one-line description on the toggle, e.g.
   * "SQL — 1 query, scanned 20.0M rows in 0.42s". Stats are the caller's to
   * phrase; this component does not know what was run.
   */
  summary?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

export function SqlBlock({
  sql,
  summary = "SQL",
  defaultOpen = false,
  className,
}: SqlBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <div className={[styles.block, className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className={styles.mark} aria-hidden="true">
          {"{ }"}
        </span>
        <span className={styles.summary}>{summary}</span>
        {/* A word, not just a chevron: the affordance has to survive being
            read aloud and being glanced at. */}
        <span className={styles.affordance}>{open ? "hide ▴" : "show ▾"}</span>
      </button>

      {/* Kept mounted and hidden so in-page find still reaches the SQL, and so
          the toggle's aria-controls always resolves to a real element. */}
      <pre id={bodyId} className={styles.pre} hidden={!open}>
        {sql}
      </pre>
    </div>
  );
}

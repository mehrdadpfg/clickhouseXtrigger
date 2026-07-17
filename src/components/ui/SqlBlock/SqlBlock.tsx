"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

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

/** Collapsed-by-default SQL, monospace throughout, with an explicit show/hide
    word rather than a bare chevron. */
export function SqlBlock({
  sql,
  summary = "SQL",
  defaultOpen = false,
  className,
}: SqlBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--r-lg)] border border-border bg-[var(--bg)]",
        className,
      )}
    >
      <button
        type="button"
        className="group flex w-full items-center gap-[9px] bg-card px-[14px] py-2.5 text-left font-mono text-[11.5px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        {/* The "{ }" mark — the design's signal that this is code. */}
        <span className="shrink-0 text-brand" aria-hidden="true">
          {"{ }"}
        </span>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          {summary}
        </span>
        {/* A word, not just a chevron: the affordance has to survive being
            read aloud and being glanced at. */}
        <span className="ml-auto shrink-0 text-[var(--text-faint)] group-hover:text-brand">
          {open ? "hide ▴" : "show ▾"}
        </span>
      </button>

      {/* Kept mounted and hidden so in-page find still reaches the SQL, and so
          the toggle's aria-controls always resolves to a real element. */}
      <pre
        id={bodyId}
        className="m-0 overflow-x-auto whitespace-pre border-t border-border px-4 py-[13px] font-mono text-[11.5px] leading-[1.65] text-[var(--text-secondary)] [tab-size:2]"
        hidden={!open}
      >
        {sql}
      </pre>
    </div>
  );
}

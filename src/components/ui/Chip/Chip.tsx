import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ChipProps {
  /** The chip's text — a column name, a filter value, a token. */
  label: ReactNode;
  /** Selected chips read as active filters; the state is visually distinct. */
  selected?: boolean;
  /** When present the chip becomes actionable (and defaults to a <button>). */
  onClick?: () => void;
  /**
   * The rendered element. Defaults to a <button> when `onClick` is given,
   * otherwise a static <span>. Force one explicitly when needed.
   */
  as?: "button" | "span";
  /** Native title — the design uses it to surface a column's full type. */
  title?: string;
  className?: string;
}

/**
 * A rounded-full token / filter chip. Neutral raised surface with a hairline
 * border; hover firms the border, selection raises the surface and brightens
 * the text. The reuse fix for the chip pattern feature code used to inline.
 */
export function Chip({
  label,
  selected = false,
  onClick,
  as,
  title,
  className,
}: ChipProps) {
  const Component = as ?? (onClick ? "button" : "span");
  const interactive = Component === "button";

  const classes = cn(
    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[11.5px] leading-tight transition-colors",
    selected
      ? "border-[var(--border-strong)] bg-[var(--surface-3)] text-[var(--text)]"
      : "border-border bg-[var(--accent-bg)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]",
    interactive &&
      "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
    className,
  );

  if (Component === "button") {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-pressed={selected}
        className={classes}
      >
        {label}
      </button>
    );
  }

  return (
    <span title={title} className={classes}>
      {label}
    </span>
  );
}

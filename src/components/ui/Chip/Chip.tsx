import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip } from "../Tooltip";

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
  /**
   * Hover label — the design uses it to surface a column's full type.
   * Rendered as a styled Tooltip rather than the browser's native box.
   */
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
    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[11.5px] leading-tight transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)]",
    selected
      ? "border-[var(--border-strong)] bg-[var(--surface-3)] text-[var(--text)]"
      : "border-border bg-[var(--accent-bg)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]",
    interactive &&
      "cursor-pointer active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
    className,
  );

  // The title becomes a styled Tooltip rather than the browser's native box.
  // Wrapping here rather than at each call site means every chip in the app —
  // column types, filter tokens, the kind chips on a finding — gets the same
  // treatment without any of them having to ask for it. Tooltip renders its
  // child untouched when there is no label, so an untitled chip is unaffected.
  const element =
    Component === "button" ? (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        className={classes}
      >
        {label}
      </button>
    ) : (
      <span className={classes}>{label}</span>
    );

  return <Tooltip label={title}>{element}</Tooltip>;
}

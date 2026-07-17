import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Badge.module.css";

export type BadgeVariant =
  | "good"
  | "warning"
  | "serious"
  | "critical"
  | "neutral"
  | "accent";

/**
 * Status is never carried by colour alone, so every variant has a glyph. This
 * is a default, not a fallback: a caller may substitute a more specific icon,
 * but cannot remove it.
 */
const DEFAULT_ICON: Record<BadgeVariant, string> = {
  good: "✓",
  warning: "▲",
  serious: "◆",
  critical: "⚠",
  neutral: "◷",
  accent: "◉",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Overrides the variant's default glyph. Cannot be emptied — see above. */
  icon?: ReactNode;
  children: ReactNode;
}

export function Badge({
  variant = "neutral",
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  const classes = [styles.badge, styles[variant], className]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} {...rest}>
      {/* aria-hidden: the glyph is a redundant encoding of the label, so a
          screen reader should read the label alone rather than "check mark". */}
      <span className={styles.icon} aria-hidden="true">
        {icon ?? DEFAULT_ICON[variant]}
      </span>
      {children}
    </span>
  );
}

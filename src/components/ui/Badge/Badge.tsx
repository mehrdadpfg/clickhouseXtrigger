import type { HTMLAttributes, ReactNode } from "react";
import { Badge as ShadcnBadge } from "../shadcn/badge";
import { cn } from "@/lib/utils";

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

/** Every variant is a hairline-bordered pill on its own faint near-black tint. */
const VARIANT_CLASS: Record<BadgeVariant, string> = {
  good: "text-[var(--good)] bg-[var(--good-bg)] border-[var(--good-border)]",
  warning:
    "text-[var(--warning)] bg-[var(--warning-bg)] border-[var(--warning-border)]",
  serious:
    "text-[var(--serious)] bg-[var(--serious-bg)] border-[var(--serious-border)]",
  critical:
    "text-[var(--critical)] bg-[var(--critical-bg)] border-[var(--critical-border)]",
  neutral: "text-muted-foreground bg-[var(--raised)] border-border",
  accent: "text-brand bg-[var(--accent-bg)] border-[var(--border-accent)]",
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
  return (
    <ShadcnBadge
      className={cn(
        "gap-[7px] rounded-full border px-3 py-[6px] text-xs font-normal leading-tight",
        VARIANT_CLASS[variant],
        className,
      )}
      {...rest}
    >
      {/* aria-hidden: the glyph is a redundant encoding of the label, so a
          screen reader should read the label alone rather than "check mark". */}
      <span className="inline-flex shrink-0 leading-none" aria-hidden="true">
        {icon ?? DEFAULT_ICON[variant]}
      </span>
      {children}
    </ShadcnBadge>
  );
}

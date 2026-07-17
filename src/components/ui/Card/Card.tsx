import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type CardTone = "neutral" | "accent" | "good" | "critical";
export type CardPadding = "none" | "sm" | "md";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
  padding?: CardPadding;
  /** Clip children to the border radius. */
  clip?: boolean;
  children?: ReactNode;
}

/** Tone — the card's border is also how the design signals state
    (approval pending, living answer, rejected). */
const TONE_CLASS: Record<CardTone, string> = {
  neutral: "border-border",
  accent: "border-[var(--border-accent)]",
  good: "border-[var(--good-border)]",
  critical: "border-[var(--critical-border)]",
};

/** `none` is for cards whose children own their own edges — the table and the
    investigation block both bleed to the border. */
const PADDING_CLASS: Record<CardPadding, string> = {
  none: "p-0",
  sm: "px-[15px] py-[13px]",
  md: "px-[18px] py-4",
};

/**
 * Flat card: surface tier + hairline border + 16px radius, NO drop shadow.
 * Depth is reserved for modals / toasts / the top bar.
 */
export function Card({
  tone = "neutral",
  padding = "md",
  clip = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--r-lg)] border bg-card font-sans text-card-foreground",
        TONE_CLASS[tone],
        PADDING_CLASS[padding],
        clip && "overflow-hidden",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

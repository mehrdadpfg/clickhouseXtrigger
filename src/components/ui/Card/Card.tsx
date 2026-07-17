import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Card.module.css";

export type CardTone = "neutral" | "accent" | "good" | "critical";
export type CardPadding = "none" | "sm" | "md";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
  padding?: CardPadding;
  /** Clip children to the border radius. */
  clip?: boolean;
  children?: ReactNode;
}

const PADDING_CLASS: Record<CardPadding, string | undefined> = {
  none: styles.padNone,
  sm: styles.padSm,
  md: styles.padMd,
};

export function Card({
  tone = "neutral",
  padding = "md",
  clip = false,
  className,
  children,
  ...rest
}: CardProps) {
  const classes = [
    styles.card,
    styles[tone],
    PADDING_CLASS[padding],
    clip ? styles.clip : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}

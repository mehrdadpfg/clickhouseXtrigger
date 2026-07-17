import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading glyph. Decorative — the label always carries the meaning. */
  icon?: ReactNode;
  /** Stretch to the container width (the approval card's primary action). */
  block?: boolean;
}

export function Button({
  variant = "ghost",
  size = "md",
  icon,
  block = false,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    styles[variant],
    styles[size],
    block ? styles.block : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type={type} className={classes} {...rest}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  );
}

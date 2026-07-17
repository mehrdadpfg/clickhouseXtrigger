import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button as ShadcnButton } from "../shadcn/button";
import { cn } from "@/lib/utils";

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

/**
 * Onyx chrome: every button is a pill. Primary is the flat white pill (no teal);
 * ghost is the neutral secondary pill; danger reads on the critical surface.
 * An icon inside the primary inherits its --btn-primary-fg foreground.
 */
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-foreground font-semibold border border-transparent hover:bg-[var(--btn-primary-hover)]",
  ghost:
    "bg-secondary text-secondary-foreground border border-[var(--btn-secondary-border)] hover:bg-secondary hover:border-[var(--btn-secondary-hover-border)]",
  danger:
    "bg-destructive text-white border border-[var(--critical-border)] hover:bg-destructive/90",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-[12.5px]",
  md: "h-9 gap-2 px-4 text-[13px]",
};

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
  return (
    <ShadcnButton
      type={type}
      className={cn(
        "rounded-full font-medium",
        SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        block && "w-full",
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex">
          {icon}
        </span>
      ) : null}
      {children}
    </ShadcnButton>
  );
}

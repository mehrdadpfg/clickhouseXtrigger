import type { CSSProperties, HTMLAttributes } from "react";
import styles from "./Spinner.module.css";

export type SpinnerSize = "sm" | "md" | "lg";

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
  /**
   * Visible text beside the ring ("running…", "queued…"). Also names the
   * status for assistive tech.
   */
  label?: string;
  /**
   * Colour of the moving arc, as a token reference. Defaults to the accent.
   * The design tints it to match whatever it reports on — a queued variant
   * spins in its series colour.
   */
  tone?: string;
}

export function Spinner({
  size = "md",
  label,
  tone,
  className,
  style,
  ...rest
}: SpinnerProps) {
  const wrapStyle = tone
    ? ({ ...style, "--spinner-tone": tone } as CSSProperties)
    : style;

  return (
    <span
      // role=status announces the label when it appears, without stealing focus.
      role="status"
      className={[styles.wrap, className].filter(Boolean).join(" ")}
      style={wrapStyle}
      {...rest}
    >
      <span className={[styles.ring, styles[size]].join(" ")} aria-hidden="true" />
      {label ? <span>{label}</span> : <span className={styles.srOnly}>Loading</span>}
    </span>
  );
}

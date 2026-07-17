import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

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

const RING_SIZE: Record<SpinnerSize, string> = {
  sm: "size-[9px] border-[1.5px]",
  md: "size-[13px] border-2",
  lg: "size-[18px] border-2",
};

export function Spinner({
  size = "md",
  label,
  tone,
  className,
  style,
  ...rest
}: SpinnerProps) {
  // The moving arc is the top border; the rest of the ring stays on the strong
  // hairline. reduce-motion callers get the ring, near-static.
  const ringStyle: CSSProperties = { borderTopColor: tone ?? "var(--accent)" };

  return (
    <span
      // role=status announces the label when it appears, without stealing focus.
      role="status"
      className={cn(
        "inline-flex items-center gap-[7px] font-mono text-[10.5px] text-muted-foreground",
        className,
      )}
      style={style}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block shrink-0 animate-spin rounded-full border-solid border-[var(--border-strong)] motion-reduce:[animation-duration:3s]",
          RING_SIZE[size],
        )}
        style={ringStyle}
      />
      {label ? <span>{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

"use client";

import type { ReactNode } from "react";
import {
  Tooltip as Root,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../shadcn/tooltip";

export interface TooltipProps {
  /** What the tooltip says. Nothing renders when this is empty. */
  label: ReactNode;
  /** The element the tooltip describes — usually an icon button. */
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** Milliseconds of hover before it opens. */
  delay?: number;
  /** Widen for long content (a full SQL string, a full column type). */
  className?: string;
}

/**
 * A hover/focus label, on the app's own surface.
 *
 * Replaces the native `title` attribute, which the browser renders as an
 * unstyled OS tooltip after a ~1s delay it does not let you change, in a place
 * it does not let you choose, and which never appears for keyboard users.
 *
 * Styled to match the CHART tooltip in EChart.tsx rather than shadcn's default.
 * shadcn ships `bg-foreground text-background` — a deliberately inverted chip,
 * which on a dark app is a white card, the same glare the ECharts default had.
 * Hovering a chart and hovering the button beside it should not produce two
 * different-looking boxes.
 *
 * `asChild` on the trigger means no wrapper element is added, so this can be
 * dropped around an existing button without disturbing flex or grid layout.
 *
 * The arrow is recoloured in shadcn/tooltip.tsx itself rather than patched over
 * from here — it is a sibling inside the content and cannot be reached from
 * outside, and those files are vendored to be edited.
 */
export function Tooltip({
  label,
  children,
  side = "top",
  delay = 250,
  className,
}: TooltipProps) {
  if (label === null || label === undefined || label === "") {
    return <>{children}</>;
  }

  return (
    <Root delayDuration={delay}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={6}
        className={[
          "max-w-[320px] rounded-[8px] border border-[var(--border-strong)] bg-[var(--raised)]",
          "px-2.5 py-1.5 font-mono text-[11.5px] leading-[1.45] text-[var(--text)]",
          "shadow-[0_8px_24px_rgba(0,0,0,0.55)]",
          className ?? "",
        ].join(" ")}
      >
        {label}
      </TooltipContent>
    </Root>
  );
}

export { TooltipProvider };

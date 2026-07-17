import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatDirection = "up" | "down" | "flat";

/**
 * Whether the movement is *good news*. Deliberately separate from `direction`:
 * up is not universally good. Trips up is good; p99 latency up is not. The
 * primitive cannot know which metric it is holding (it has no domain
 * knowledge), so the caller says. Defaults to the design's reading —
 * up/good, down/bad — because that is the common case, not because it is a law.
 */
export type StatSentiment = "good" | "bad" | "neutral";

export interface StatDelta {
  /** Pre-formatted, e.g. "11.8%". The tile supplies the arrow. */
  value: string;
  direction: StatDirection;
  sentiment?: StatSentiment;
  /** Trailing context, e.g. "vs Jun". Rendered dimmer than the number. */
  note?: string;
}

export interface StatFootnote {
  label: string;
  value?: string;
}

export interface StatTileProps {
  label: ReactNode;
  /** Pre-formatted. Rounding and locale are the caller's business. */
  value: string | number;
  /** Rides the number's baseline, e.g. "M", "$", "ms". */
  unit?: string;
  delta?: StatDelta;
  /** Rendered under a divider, as a spaced row. */
  footnotes?: StatFootnote[];
  size?: "md" | "lg";
  className?: string;
}

const ARROW: Record<StatDirection, string> = {
  up: "▲",
  down: "▼",
  flat: "±",
};

const DEFAULT_SENTIMENT: Record<StatDirection, StatSentiment> = {
  up: "good",
  down: "bad",
  flat: "neutral",
};

const SENTIMENT_CLASS: Record<StatSentiment, string> = {
  good: "text-[var(--good)]",
  bad: "text-[var(--critical)]",
  neutral: "text-muted-foreground",
};

export function StatTile({
  label,
  value,
  unit,
  delta,
  footnotes,
  size = "lg",
  className,
}: StatTileProps) {
  const sentiment = delta
    ? (delta.sentiment ?? DEFAULT_SENTIMENT[delta.direction])
    : null;

  const md = size === "md";

  return (
    <div className={cn("font-sans", className)}>
      <span className="text-[12px] text-[var(--text-secondary)]">{label}</span>

      <div
        className={cn("mt-2 flex items-end", md ? "gap-2.5" : "gap-[14px]")}
      >
        <span
          className={cn(
            "tnum font-semibold leading-none tracking-[-0.02em] text-[var(--text)]",
            md ? "text-[28px]" : "text-[46px]",
          )}
        >
          {value}
          {unit ? (
            <span
              className={cn(
                "text-muted-foreground",
                md ? "text-[16px]" : "text-[24px]",
              )}
            >
              {unit}
            </span>
          ) : null}
        </span>

        {delta && sentiment ? (
          <span
            className={cn(
              "tnum whitespace-nowrap font-mono",
              md ? "pb-[3px] text-[11.5px]" : "pb-[7px] text-[13px]",
              SENTIMENT_CLASS[sentiment],
            )}
          >
            {/* The arrow is a redundant encoding of direction so the delta does
                not rely on colour alone; the note reads as normal text. */}
            <span aria-hidden="true">{ARROW[delta.direction]}</span>{" "}
            {delta.value}
            {delta.note ? (
              <span className="text-[var(--text-faint)]"> {delta.note}</span>
            ) : null}
          </span>
        ) : null}
      </div>

      {footnotes && footnotes.length > 0 ? (
        <>
          <hr className="my-[14px] mb-[11px] h-px border-0 bg-border" />
          <div className="tnum flex flex-wrap justify-between gap-3 font-mono text-[11px] text-muted-foreground">
            {footnotes.map((f) => (
              <span key={f.label}>
                {f.label}
                {f.value ? (
                  <span className="text-[var(--text-secondary)]"> {f.value}</span>
                ) : null}
              </span>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

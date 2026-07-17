import type { ReactNode } from "react";
import styles from "./StatTile.module.css";

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

  const classes = [
    size === "md" ? styles.sizeMd : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes || undefined}>
      <span className={styles.label}>{label}</span>

      <div className={styles.row}>
        <span className={`tnum ${styles.value}`}>
          {value}
          {unit ? <span className={styles.unit}>{unit}</span> : null}
        </span>

        {delta && sentiment ? (
          <span className={`tnum ${styles.delta} ${styles[sentiment]}`}>
            {/* The arrow is a redundant encoding of direction so the delta does
                not rely on colour alone; the note reads as normal text. */}
            <span aria-hidden="true">{ARROW[delta.direction]}</span>{" "}
            {delta.value}
            {delta.note ? (
              <span className={styles.deltaNote}> {delta.note}</span>
            ) : null}
          </span>
        ) : null}
      </div>

      {footnotes && footnotes.length > 0 ? (
        <>
          <hr className={styles.divider} />
          <div className={`tnum ${styles.footnotes}`}>
            {footnotes.map((f) => (
              <span key={f.label}>
                {f.label}
                {f.value ? (
                  <span className={styles.footnoteValue}> {f.value}</span>
                ) : null}
              </span>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

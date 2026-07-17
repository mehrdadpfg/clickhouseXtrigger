import styles from "./Reading.module.css";

/**
 * A number, plus whether it is still being re-run.
 *
 * Design Reference, "Living answer vs frozen". The two modes are not a style
 * choice — they are the difference between a figure the background task is
 * still refreshing and one that stopped moving when someone paused it. Reading
 * a stale number as current is the mistake this component exists to prevent,
 * so the mode is required and there is no default.
 *
 * Domain-free enough to be a ui/ primitive, but it is not one: living/frozen is
 * Vantage's vocabulary, not a general-purpose card.
 */
export type ReadingMode = "living" | "frozen";

/** Living readings are green; a firing one is red. Frozen is always muted. */
export type ReadingTone = "neutral" | "critical";

export interface ReadingProps {
  mode: ReadingMode;
  tone?: ReadingTone;
  /** Pre-formatted — the caller owns rounding and units. */
  value: string;
  /** What keeps it moving, e.g. "re-runs every 6h". Living only. */
  cadencePhrase?: string;
  /** "updated 2m ago" when living, "as of Jul 16, 09:00" when frozen. */
  stamp?: string;
  /** Trailing context under the number, e.g. "vs −20% threshold". */
  note?: string;
  /** Drop the card's own border and background — for use inside another card. */
  bare?: boolean;
  className?: string;
}

export function Reading({
  mode,
  tone = "neutral",
  value,
  cadencePhrase,
  stamp,
  note,
  bare = false,
  className,
}: ReadingProps) {
  const living = mode === "living";

  const classes = [
    styles.reading,
    living ? styles.living : styles.frozen,
    living && tone === "critical" ? styles.critical : null,
    bare ? styles.bare : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      {/* The rail is the at-a-glance signal; it only means anything on a
          living reading, so a frozen one does not draw it. */}
      {living ? <span className={styles.rail} aria-hidden="true" /> : null}

      <div className={styles.head}>
        <span className={styles.mode}>
          {living ? (
            <span className={styles.dot} aria-hidden="true" />
          ) : (
            <span aria-hidden="true">◷</span>
          )}
          {living ? "LIVING" : "FROZEN"}
          {living
            ? cadencePhrase
              ? ` · ${cadencePhrase}`
              : null
            : " · snapshot"}
        </span>
        {stamp ? <span className={styles.stamp}>{stamp}</span> : null}
      </div>

      <div className={styles.row}>
        <span className={`tnum ${styles.value}`}>{value}</span>
        {note ? <span className={`tnum ${styles.note}`}>{note}</span> : null}
      </div>
    </div>
  );
}

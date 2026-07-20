"use client";

import { Button, Select, type SelectOption } from "@/components/ui";
import {
  REFRESH_INTERVALS,
  type RefreshInterval,
} from "./refreshInterval";
import styles from "./BoardDetail.module.css";

/** The cadences without their `ms`, which is the scheduler's business. */
const INTERVAL_OPTIONS: SelectOption<RefreshInterval>[] = REFRESH_INTERVALS.map(
  ({ value, label }) => ({ value, label }),
);

/**
 * The board's refresh cluster: run every tile now, and how often to do it
 * unprompted.
 *
 * One control for the whole board rather than N. The per-tile ⟳ stays for the
 * single-tile case, but "the numbers I am looking at are old" is a statement
 * about the board, and answering it by pressing ten buttons in a row is ten
 * serialised round trips (see BoardDetail) for one question.
 */
export function RefreshControl({
  interval,
  onIntervalChange,
  onRefresh,
  refreshing,
  failed,
  total,
}: {
  interval: RefreshInterval;
  onIntervalChange: (next: RefreshInterval) => void;
  onRefresh: () => void;
  /** A board run is in flight. Also what stops a second one being started. */
  refreshing: boolean;
  /** Tiles currently showing a failure — 0 when the last run was clean. */
  failed: number;
  total: number;
}) {
  return (
    <>
      {/* Partial failure is the thing worth seeing, so it is stated in words
          next to the control that caused it. A single board-wide spinner that
          simply stopped would hide the fact that nine tiles are current and one
          is not; the failed tiles keep their last good numbers and mark
          themselves, and this is the summary that sends the reader to them.

          role="status" rather than "alert": it is a result, announced once the
          run settles, not an interruption. */}
      {failed > 0 ? (
        <p className={styles.partial} role="status">
          {failed === total
            ? total === 1
              ? "Tile failed to refresh"
              : "All tiles failed to refresh"
            : `${failed} of ${total} tiles failed to refresh`}
        </p>
      ) : null}

      {/* A dropdown, not the SegmentedControl the modals use: five options laid
          out as pills is a wide strip of chrome for a setting most readers leave
          alone, and this one has to sit in a header that already wraps.

          It opens right-aligned because the cluster sits at the end of that
          header — a menu hung off the left edge of a trigger that close to the
          viewport edge opens past it on a narrow window. */}
      <Select<RefreshInterval>
        label="Auto"
        options={INTERVAL_OPTIONS}
        value={interval}
        onChange={onIntervalChange}
        align="end"
      />

      {/* The label carries the running state, matching the per-tile ⟳: tiles
          hold their last good rows through a run, so there is no change in the
          board itself to read the state off. No tooltip — a disabled trigger
          swallows the hover that would open one, and the word is already here. */}
      <Button
        variant="ghost"
        size="sm"
        icon="⟳"
        onClick={onRefresh}
        disabled={refreshing}
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
    </>
  );
}

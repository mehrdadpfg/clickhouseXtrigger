"use client";

import { Spinner } from "@/components/ui";
import { Sparkline } from "../Sparkline/Sparkline";
import {
  branchColor,
  formatDelta,
  formatMetric,
  type BranchView,
} from "../model";
import styles from "./BranchTile.module.css";

/**
 * One variant, at whatever stage it has reached.
 *
 * The tile is drawn in its branch's fixed colour from the first frame — named
 * and spinning while the run is still queued, then filling in its small multiple
 * when the data lands, or its error when the branch fails. Because the colour
 * comes from `colorSlot` (fixed at fork time), nothing in this tile changes when
 * a *sibling* is culled.
 */

interface BranchTileProps {
  branch: BranchView;
  unit?: string;
  /** The shared scale — identical on every sibling. */
  scale: { domain: [number, number]; ticks: number[] };
  xCount: number;
  /** Only a settled, readable branch can be pinned. */
  selectable: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onCull: (id: string) => void;
}

export function BranchTile({
  branch,
  unit,
  scale,
  xCount,
  selectable,
  selected,
  onSelect,
  onCull,
}: BranchTileProps) {
  const color = branchColor(branch);
  const delta = formatDelta(branch.delta);
  // Direction rides a glyph, not a colour: a delta is data, and the palette's
  // reds/greens are reserved for real status (a firing watcher), never a series.
  const arrow =
    branch.delta == null ? "" : branch.delta > 0 ? "▲" : branch.delta < 0 ? "▼" : "";

  const isFailed = branch.status === "failed";
  const isComplete = branch.status === "complete";
  const isPending = branch.status === "queued" || branch.status === "running";

  const tileClasses = [
    styles.tile,
    selected ? styles.selected : null,
    isFailed ? styles.failed : null,
  ]
    .filter(Boolean)
    .join(" ");

  const clickable = selectable && isComplete;

  return (
    <div
      className={tileClasses}
      style={{ ["--branch-color" as string]: color }}
      data-selected={selected || undefined}
    >
      <div className={styles.head}>
        <button
          type="button"
          className={styles.selectArea}
          onClick={clickable ? () => onSelect(branch.id) : undefined}
          disabled={!clickable}
          aria-pressed={clickable ? selected : undefined}
        >
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.name}>{branch.label}</span>
          {selected && (
            <span className={styles.check} aria-label="selected">
              ✓
            </span>
          )}
        </button>

        <div className={styles.status}>
          {isComplete && (
            <span className={styles.reading}>
              <span className="tnum">{formatMetric(branch.headline, unit)}</span>
              {delta && (
                <span className={styles.delta}>
                  <span aria-hidden="true">{arrow}</span> {delta}
                </span>
              )}
            </span>
          )}
          {branch.status === "running" && (
            <Spinner size="sm" label="running…" tone={color} />
          )}
          {branch.status === "queued" && (
            <Spinner size="sm" label="queued…" tone={color} />
          )}
          {isFailed && (
            <span className={styles.failLabel}>
              <span aria-hidden="true">⚠</span> failed
            </span>
          )}
        </div>

        <button
          type="button"
          className={styles.cull}
          onClick={() => onCull(branch.id)}
          aria-label={`Remove ${branch.label}`}
          title="Remove variant"
        >
          ✕
        </button>
      </div>

      <div className={styles.body}>
        {isComplete &&
          (branch.points.length > 0 ? (
            <Sparkline
              points={branch.points}
              domain={scale.domain}
              ticks={scale.ticks}
              xCount={xCount}
              color={color}
              label={branch.label}
            />
          ) : (
            <p className={styles.empty}>No rows for this variant.</p>
          ))}

        {isPending && (
          <div className={styles.skeleton} aria-hidden="true">
            {[36, 48, 42, 58, 50, 44, 52].map((h, i) => (
              <span key={i} style={{ height: `${h}%` }} />
            ))}
          </div>
        )}

        {isFailed && (
          <p className={styles.error}>
            {branch.error ?? "This branch could not complete."}
          </p>
        )}
      </div>
    </div>
  );
}

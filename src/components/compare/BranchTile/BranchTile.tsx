"use client";

import { Badge, Card, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Sparkline } from "../Sparkline/Sparkline";
import {
  branchColor,
  formatDelta,
  formatMetric,
  type BranchView,
} from "../model";

/**
 * One variant, at whatever stage it has reached.
 *
 * The tile is drawn in its branch's fixed colour from the first frame — named
 * and spinning while the run is still queued, then filling in its small multiple
 * when the data lands, or its error when the branch fails. Because the colour
 * comes from `colorSlot` (fixed at fork time), nothing in this tile changes when
 * a *sibling* is culled.
 *
 * The surface is the shared flat Card; the left edge carries the branch's fixed
 * colour so the tile stays identifiable through every state.
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

  const clickable = selectable && isComplete;

  return (
    <Card
      padding="none"
      tone={isFailed ? "critical" : selected ? "accent" : "neutral"}
      className={cn(
        "border-l-[3px] px-[13px] py-3 transition-colors",
        isFailed && "bg-[var(--critical-bg)]",
      )}
      style={{
        ["--branch-color" as string]: color,
        borderLeftColor: "var(--branch-color)",
      }}
      data-selected={selected || undefined}
    >
      <div className="mb-[9px] flex items-center gap-[7px]">
        <button
          type="button"
          className="m-0 flex min-w-0 flex-[0_1_auto] cursor-pointer items-center gap-[7px] border-0 bg-transparent p-0 text-left disabled:cursor-default focus-visible:rounded-[var(--r-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          onClick={clickable ? () => onSelect(branch.id) : undefined}
          disabled={!clickable}
          aria-pressed={clickable ? selected : undefined}
        >
          <span
            className="h-2 w-2 shrink-0 rounded-[2px] bg-[var(--branch-color)]"
            aria-hidden="true"
          />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium text-[var(--text)]">
            {branch.label}
          </span>
          {selected && (
            <span
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] text-[var(--bg)]"
              aria-label="selected"
            >
              ✓
            </span>
          )}
        </button>

        <div className="ml-auto flex shrink-0 items-center">
          {isComplete && (
            <span className="inline-flex items-baseline gap-1.5 font-mono text-[12px] text-[var(--text)]">
              <span className="tnum">{formatMetric(branch.headline, unit)}</span>
              {delta && (
                <span className="text-[10.5px] text-muted-foreground">
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
          {isFailed && <Badge variant="critical">failed</Badge>}
        </div>

        <button
          type="button"
          className="-my-0.5 -mr-1 shrink-0 cursor-pointer rounded-[var(--r-sm)] border-0 bg-transparent px-1 py-0.5 text-[12px] leading-none text-[var(--text-faint)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
          onClick={() => onCull(branch.id)}
          aria-label={`Remove ${branch.label}`}
          title="Remove variant"
        >
          ✕
        </button>
      </div>

      <div className="min-h-[54px]">
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
            <p className="m-0 py-[18px] text-[11.5px] leading-normal text-muted-foreground">
              No rows for this variant.
            </p>
          ))}

        {isPending && (
          <div className="flex h-[54px] items-end gap-1" aria-hidden="true">
            {[36, 48, 42, 58, 50, 44, 52].map((h, i) => (
              <span
                key={i}
                className="flex-1 animate-pulse rounded-[2px] motion-reduce:animate-none"
                style={{
                  height: `${h}%`,
                  background:
                    "color-mix(in srgb, var(--branch-color) 22%, var(--raised))",
                }}
              />
            ))}
          </div>
        )}

        {isFailed && (
          <p className="m-0 break-words py-1.5 font-mono text-[11.5px] leading-normal text-[var(--critical)]">
            {branch.error ?? "This branch could not complete."}
          </p>
        )}
      </div>
    </Card>
  );
}

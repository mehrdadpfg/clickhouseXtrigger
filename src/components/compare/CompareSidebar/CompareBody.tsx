"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Card, Chip } from "@/components/ui";
import { BranchTile } from "../BranchTile/BranchTile";
import {
  hasAnyData,
  sharedScaleLabel,
  sharedXCount,
  sharedYScale,
  type BranchView,
  type CompareView,
  type VariantSuggestion,
} from "../model";

/**
 * Compare variants — the fork surface as a PLAIN BLOCK.
 *
 * This is the sidebar's body lifted out of its fixed right-drawer: the base
 * recap, the branch tiles on one shared scale, the add-variant panel, and the
 * pin/board footer, rendered inline so it can be dropped into the docked Analyze
 * panel's "Compare variants" section. No overlay, no header/close — the panel
 * that hosts it owns those.
 *
 * The two invariants that make the comparison honest live here, unchanged:
 *   * one scale — `sharedYScale`/`sharedXCount` are computed once and handed
 *     identically to every tile; and
 *   * fixed colour — each branch carries the palette slot it was forked with, so
 *     culling one leaves the survivors exactly as they were.
 */

interface CompareBodyProps {
  view: CompareView;
  /** Ready-made ways to vary the question, shown in the add panel. */
  suggestions?: VariantSuggestion[];
  /** Drop a branch from the set. Must not disturb the survivors' colours. */
  onCull: (branchId: string) => void;
  /** The analyst asks for another variant — the host forks a new branch. */
  onAddVariant: (input: {
    label: string;
    description?: string;
    suggestionId?: string;
    custom?: string;
  }) => void;
  /** Promote one variant to a board of its own. */
  onPin: (branch: BranchView) => void;
  /** Turn the whole set into a board. */
  onBuildBoard: () => void;
  /** Disables the exits while an action is in flight. */
  busy?: boolean;
}

export function CompareBody({
  view,
  suggestions = [],
  onCull,
  onAddVariant,
  onPin,
  onBuildBoard,
  busy = false,
}: CompareBodyProps) {
  const { base, branches } = view;

  // The scale is derived once and shared. Recomputed as branches land, never
  // per tile — that is what makes the small multiples comparable.
  const scale = useMemo(() => sharedYScale(branches), [branches]);
  const xCount = useMemo(() => sharedXCount(branches), [branches]);
  const scaleReady = hasAnyData(branches);

  const completeIds = useMemo(
    () => branches.filter((b) => b.status === "complete").map((b) => b.id),
    [branches],
  );

  // Selection follows the data: default to the first settled branch, and if the
  // selected one is culled or fails, fall back rather than point at nothing.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId && completeIds.includes(selectedId)) return;
    setSelectedId(completeIds[0] ?? null);
  }, [completeIds, selectedId]);

  const selected = branches.find((b) => b.id === selectedId) ?? null;

  const [addOpen, setAddOpen] = useState(false);
  const [custom, setCustom] = useState("");

  function submitCustom() {
    const text = custom.trim();
    if (!text) return;
    onAddVariant({ label: text, custom: text });
    setCustom("");
    setAddOpen(false);
  }

  return (
    <div className="flex flex-col gap-[13px]">
      <div>
        <div className="mb-1.5 text-[12px] text-muted-foreground">
          Base ·{" "}
          <strong className="font-medium text-[var(--text)]">
            {base.question}
          </strong>
        </div>
        <div className="flex flex-wrap items-center gap-[7px] font-mono text-[10.5px]">
          <span className="text-[var(--text-faint)]">varying:</span>
          <Chip label={base.varying} />
          {scaleReady && (
            <span className="text-[var(--text-faint)]">
              · {sharedScaleLabel(scale, base.unit)}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-[11px]">
        {branches.map((branch) => (
          <BranchTile
            key={branch.id}
            branch={branch}
            unit={base.unit}
            scale={scale}
            xCount={xCount}
            selectable={completeIds.length > 0}
            selected={branch.id === selectedId}
            onSelect={setSelectedId}
            onCull={onCull}
          />
        ))}

        {addOpen && (
          <Card tone="accent" padding="none" className="px-[13px] py-3">
            <div className="mb-[9px] font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              Vary the {base.varying} by…
            </div>
            {suggestions.length > 0 && (
              <div className="mb-2.5 flex flex-wrap gap-[7px]">
                {suggestions.map((suggestion) => (
                  <Chip
                    key={suggestion.id}
                    label={suggestion.label}
                    onClick={() => {
                      onAddVariant({
                        label: suggestion.label,
                        description: suggestion.description,
                        suggestionId: suggestion.id,
                      });
                      setAddOpen(false);
                    }}
                  />
                ))}
              </div>
            )}
            <form
              className="flex gap-[7px]"
              onSubmit={(event) => {
                event.preventDefault();
                submitCustom();
              }}
            >
              <input
                className="min-w-0 flex-1 rounded-[var(--r-md)] border border-border bg-[var(--raised)] px-2.5 py-[7px] font-mono text-[11px] text-[var(--text)] placeholder:text-[var(--text-faint)] focus-visible:border-[var(--border-accent)] focus-visible:outline-none"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                placeholder="type a variant, e.g. weekends only…"
                aria-label="Custom variant"
                /* eslint-disable-next-line jsx-a11y/no-autofocus */
                autoFocus
              />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={!custom.trim()}
              >
                Add
              </Button>
            </form>
          </Card>
        )}

        <Button
          variant="ghost"
          block
          icon="＋"
          onClick={() => setAddOpen((open) => !open)}
          aria-expanded={addOpen}
        >
          Add a variant…
        </Button>
      </div>

      <div className="flex flex-col gap-[9px] border-t border-border pt-[13px]">
        <div className="text-[12px] leading-normal text-muted-foreground">
          {selected ? (
            <>
              Selected ·{" "}
              <strong className="font-medium text-[var(--text)]">
                {selected.label}
              </strong>
              . Pin it to a board of its own, or save the whole set.
            </>
          ) : (
            <>Select a finished variant to pin it to a board.</>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            block
            icon="◆"
            disabled={!selected || busy}
            onClick={() => selected && onPin(selected)}
          >
            Pin selected to board
          </Button>
          <Button
            variant="ghost"
            block
            disabled={completeIds.length === 0 || busy}
            onClick={onBuildBoard}
          >
            Save all as board →
          </Button>
        </div>
      </div>
    </div>
  );
}

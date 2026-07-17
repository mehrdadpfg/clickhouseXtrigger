"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
 * Compare variants — the fork surface, as a right-hand drawer.
 *
 * It runs one question several ways at once and lets the analyst read the
 * answers side by side on ONE shared scale. Everything live about it — which
 * branches exist, how far each has got — arrives as `view.branches`, which the
 * route keeps in step with the durable runs. This component owns only the local
 * intent: which variant is selected to pin, and whether the "add a variant"
 * panel is open.
 *
 * Two invariants make the comparison honest, and both live below:
 *   * one scale — `sharedYScale`/`sharedXCount` are computed once, here, and
 *     handed identically to every tile; and
 *   * fixed colour — each branch carries the palette slot it was forked with, so
 *     culling one leaves the survivors exactly as they were.
 */

interface CompareSidebarProps {
  view: CompareView;
  /** Ready-made ways to vary the question, shown in the add panel. */
  suggestions?: VariantSuggestion[];
  onClose: () => void;
  /** Drop a branch from the set. Must not disturb the survivors' colours. */
  onCull: (branchId: string) => void;
  /** The analyst asks for another variant — the route forks a new branch. */
  onAddVariant: (input: {
    label: string;
    description?: string;
    suggestionId?: string;
    custom?: string;
  }) => void;
  /** Promote one variant to the thread, replacing the answer. */
  onPin: (branch: BranchView) => void;
  /** Turn the whole set into a board. */
  onBuildBoard: () => void;
  /** Disables the exits while an action is in flight. */
  busy?: boolean;
}

export function CompareSidebar({
  view,
  suggestions = [],
  onClose,
  onCull,
  onAddVariant,
  onPin,
  onBuildBoard,
  busy = false,
}: CompareSidebarProps) {
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

  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  function submitCustom() {
    const text = custom.trim();
    if (!text) return;
    onAddVariant({ label: text, custom: text });
    setCustom("");
    setAddOpen(false);
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex animate-in justify-end fade-in motion-reduce:animate-none"
      style={{ background: "color-mix(in srgb, var(--bg) 55%, transparent)" }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        className="flex h-full w-[440px] max-w-[92vw] animate-in flex-col border-l border-[var(--border-strong)] bg-background slide-in-from-right-4 focus:outline-none motion-reduce:animate-none"
        style={{
          boxShadow: "-16px 0 60px color-mix(in srgb, var(--bg) 60%, transparent)",
        }}
        role="dialog"
        aria-label="Compare variants"
        aria-modal="true"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="flex items-center gap-[9px] border-b border-border px-[18px] py-4">
          <span className="text-[15px] text-brand" aria-hidden="true">
            ⑃
          </span>
          <h2 className="m-0 text-[14.5px] font-semibold text-[var(--text)]">
            Compare variants
          </h2>
          <button
            type="button"
            className="ml-auto cursor-pointer rounded-[var(--r-sm)] border-0 bg-transparent px-1 py-0.5 text-[16px] leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="border-b border-border px-[18px] py-[14px]">
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

        <div className="flex flex-1 flex-col gap-[11px] overflow-y-auto px-[18px] py-[14px]">
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
                  placeholder="or type a custom filter…"
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

        <footer className="flex flex-col gap-[9px] border-t border-border px-[18px] py-[13px]">
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
        </footer>
      </div>
    </div>
  );
}

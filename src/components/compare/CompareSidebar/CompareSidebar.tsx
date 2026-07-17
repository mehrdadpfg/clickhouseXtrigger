"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";
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
import styles from "./CompareSidebar.module.css";

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
      className={styles.overlay}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-label="Compare variants"
        aria-modal="true"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className={styles.header}>
          <span className={styles.glyph} aria-hidden="true">
            ⑃
          </span>
          <h2 className={styles.title}>Compare variants</h2>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className={styles.baseRow}>
          <div className={styles.baseLine}>
            Base · <strong>{base.question}</strong>
          </div>
          <div className={styles.varying}>
            <span className={styles.varyingKey}>varying:</span>
            <span className={styles.varyingChip}>{base.varying}</span>
            {scaleReady && (
              <span className={styles.scaleNote}>
                · {sharedScaleLabel(scale, base.unit)}
              </span>
            )}
          </div>
        </div>

        <div className={styles.list}>
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
            <div className={styles.addPanel}>
              <div className={styles.addTitle}>Vary the {base.varying} by…</div>
              <div className={styles.suggestions}>
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    type="button"
                    className={styles.suggestion}
                    onClick={() => {
                      onAddVariant({
                        label: suggestion.label,
                        description: suggestion.description,
                        suggestionId: suggestion.id,
                      });
                      setAddOpen(false);
                    }}
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
              <form
                className={styles.customRow}
                onSubmit={(event) => {
                  event.preventDefault();
                  submitCustom();
                }}
              >
                <input
                  className={styles.customInput}
                  value={custom}
                  onChange={(event) => setCustom(event.target.value)}
                  placeholder="or type a custom filter…"
                  aria-label="Custom variant"
                  /* eslint-disable-next-line jsx-a11y/no-autofocus */
                  autoFocus
                />
                <button
                  type="submit"
                  className={styles.customAdd}
                  disabled={!custom.trim()}
                >
                  Add
                </button>
              </form>
            </div>
          )}

          <button
            type="button"
            className={styles.addButton}
            onClick={() => setAddOpen((open) => !open)}
            aria-expanded={addOpen}
          >
            ＋ Add a variant…
          </button>
        </div>

        <footer className={styles.footer}>
          <div className={styles.selectedLine}>
            {selected ? (
              <>
                Selected · <strong>{selected.label}</strong>. Pinning replaces
                the answer in the thread with this variant.
              </>
            ) : (
              <>Select a finished variant to pin it as the answer.</>
            )}
          </div>
          <div className={styles.actions}>
            <Button
              variant="primary"
              block
              icon="◆"
              disabled={!selected || busy}
              onClick={() => selected && onPin(selected)}
            >
              Pin selected as answer
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

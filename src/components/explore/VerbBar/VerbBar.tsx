"use client";

import type { VerbKey } from "@/lib/discover/model";
import styles from "../FindingCard/FindingCard.module.css";

/**
 * The four verbs, identical on every card. Client-safe labels/glyphs (the recipes
 * live server-side in lib/discover/verbs). Clicking one runs that verb against the
 * card's finding and grows a child card in the walk.
 */
export const VERB_UI: readonly { key: VerbKey; label: string; glyph: string }[] = [
  { key: "why", label: "Why?", glyph: "?" },
  { key: "disagree", label: "Who disagrees?", glyph: "✓" },
  { key: "shape", label: "Same shape?", glyph: "≈" },
  { key: "weird", label: "What's weird?", glyph: "◎" },
];

/** Verb → its label, for building the breadcrumb trail. */
export const VERB_LABEL: Record<VerbKey, string> = {
  why: "Why?",
  disagree: "Who disagrees?",
  shape: "Same shape?",
  weird: "What's weird?",
};

export function VerbBar({ onVerb }: { onVerb: (verb: VerbKey) => void }) {
  return (
    <div className={styles.verbs}>
      {VERB_UI.map((v) => (
        <button
          key={v.key}
          type="button"
          className={styles.verb}
          onClick={() => onVerb(v.key)}
        >
          <span className={styles.verbGlyph} aria-hidden="true">
            {v.glyph}
          </span>{" "}
          {v.label}
        </button>
      ))}
    </div>
  );
}

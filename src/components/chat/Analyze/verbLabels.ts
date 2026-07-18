import type { VerbKey } from "@/lib/discover/model";

/**
 * The four verbs' client-safe labels and glyphs — copied from the explore VerbBar
 * (VERB_UI) so the Analyze panel doesn't import from src/components/explore, which
 * stage 4 deletes. The statistical recipes stay server-side in lib/discover/verbs.
 * The same idea reads the same everywhere.
 */
export const VERB_UI: readonly { key: VerbKey; label: string; glyph: string }[] = [
  { key: "why", label: "Why?", glyph: "?" },
  { key: "disagree", label: "Who disagrees?", glyph: "✓" },
  { key: "shape", label: "Same shape?", glyph: "≈" },
  { key: "weird", label: "What's weird?", glyph: "◎" },
];

/** Verb → its label. */
export const VERB_LABEL: Record<VerbKey, string> = {
  why: "Why?",
  disagree: "Who disagrees?",
  shape: "Same shape?",
  weird: "What's weird?",
};

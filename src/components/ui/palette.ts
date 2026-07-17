/* The categorical palette. No domain knowledge — a slot in, a token out. The
   --series-* tokens are read off :root by whatever renders the mark. */

/** The palette has eight categorical slots. There is no ninth. */
export const SERIES_SLOTS = 8;
export const OTHER_LABEL = "Other";

/**
 * Slot -> token. Fixed order, never cycled: slot 0 is always --series-1, and a
 * slot past the eighth is always --series-other. Generating a hue, or wrapping
 * back to --series-1, would make two entities share a colour.
 */
export function slotColor(slot: number): string {
  return slot >= 0 && slot < SERIES_SLOTS
    ? `var(--series-${slot + 1})`
    : "var(--series-other)";
}

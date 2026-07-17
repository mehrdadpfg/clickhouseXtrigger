import type { ReactNode } from "react";

/**
 * Minimal inline markdown for the agent's answers: **bold**, *italic*, `code`.
 * The answers are one or two sentences now, so a full markdown engine would be
 * more than the text needs. Unclosed tokens (mid-stream) render literally until
 * their closing delimiter arrives — a brief, self-correcting flicker.
 */
const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;

export function inlineMarkdown(text: string): ReactNode[] {
  return text.split(TOKEN).map((chunk, i) => {
    if (chunk.startsWith("**") && chunk.endsWith("**")) {
      return <strong key={i}>{chunk.slice(2, -2)}</strong>;
    }
    if (chunk.startsWith("`") && chunk.endsWith("`")) {
      return <code key={i}>{chunk.slice(1, -1)}</code>;
    }
    if (chunk.startsWith("*") && chunk.endsWith("*")) {
      return <em key={i}>{chunk.slice(1, -1)}</em>;
    }
    return chunk;
  });
}

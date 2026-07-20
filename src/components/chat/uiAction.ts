/**
 * Messages the UI sends on the reader's behalf — a button press, a picked
 * option — rather than something they typed.
 *
 * They have to be real user messages: they carry the intent the agent acts on.
 * But printing "Set up a watcher on …, ask me which number to watch and what
 * threshold should trip it" as a chat bubble reads as words the reader never
 * wrote, and a picked option is already shown on the card that offered it.
 *
 * So the intent is marked in the TEXT, not in message metadata: metadata would
 * have to survive the Trigger transport and the round trip through Postgres,
 * and if it didn't, every hidden message would reappear as a bubble on reload.
 * A prefix in the content survives both unconditionally. The agent sees it too,
 * which is a small bonus — it can tell a click from a sentence.
 */

const PREFIX = "[ui:";

/** Tag a message as UI-originated, with the short label the thread shows. */
export function markUiAction(label: string, body: string): string {
  return `${PREFIX}${label}] ${body}`;
}

/** The label, if this message came from the UI; null if the reader typed it. */
export function readUiAction(text: string): string | null {
  if (!text.startsWith(PREFIX)) return null;
  const end = text.indexOf("] ");
  if (end === -1) return null;
  const label = text.slice(PREFIX.length, end).trim();
  return label === "" ? null : label;
}

/**
 * Resolving an @-mentioned watcher into agent context.
 *
 * Like a dashboard (and unlike a table), a watcher is not something the agent
 * can discover with its own tools — it lives in Postgres, not ClickHouse. So
 * when the reader @-mentions a watcher, its definition is loaded here and
 * injected into the turn (see trigger/chat.ts `prepareMessages`), so the agent
 * can reason about "this watcher": what it measures, the rule it trips on, how
 * often it checks, where it stands right now, and the SQL behind it.
 *
 * Server-only: it reads Postgres. The token spelling comes from the shared
 * `watcherMentionToken`, so a question is matched here exactly as the composer
 * wrote it.
 */
import {
  STATUS_LABEL,
  cadencePhrase,
  formatReading,
  ruleLabel,
  watcherMentionToken,
  watcherStatus,
} from "@/components/watch/model";
import { listWatchers } from "@/lib/db/watchers";

/** Every `@word` token in a block of text, at a word boundary — the composer's rule. */
function mentionTokens(text: string): Set<string> {
  const found = new Set<string>();
  const pattern = /(^|\s)(@[\w.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) found.add(match[2]!);
  return found;
}

/**
 * The context block for every watcher @-mentioned anywhere in `text`, or null.
 *
 * `text` is the concatenation of the conversation's user messages, so a watcher
 * named in an earlier turn keeps its context on later turns rather than going
 * cold the moment the reader stops naming it. Two watchers that share a question
 * both resolve — the agent hears about each — the same way two like-named boards
 * do.
 */
export async function loadMentionedWatchersContext(
  text: string,
): Promise<string | null> {
  if (!text.includes("@")) return null;

  const tokens = mentionTokens(text);
  if (tokens.size === 0) return null;

  let watchers;
  try {
    watchers = await listWatchers();
  } catch (cause) {
    // Context is a bonus, never the turn: a dead watcher read must not fail it.
    console.error("Could not load watchers for @-mention context", cause);
    return null;
  }

  const mentioned = watchers.filter((w) =>
    tokens.has(watcherMentionToken(w.question)),
  );
  if (mentioned.length === 0) return null;

  const blocks = mentioned.map((w) => {
    const reading =
      w.last_value === null
        ? "not run yet"
        : formatReading(w.last_value, w.threshold.unit);
    const lines = [
      `Watcher "${w.question}"`,
      `Rule: ${ruleLabel(w.threshold)}`,
      `Cadence: ${cadencePhrase(w.schedule)}`,
      `Status: ${STATUS_LABEL[watcherStatus(w)]}`,
      `Last reading: ${reading}`,
      ...(w.last_error ? [`Last error: ${w.last_error}`] : []),
      `SQL: ${w.sql}`,
    ];
    return lines.join("\n");
  });

  return blocks.join("\n\n");
}

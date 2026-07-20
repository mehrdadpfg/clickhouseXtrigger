import { PromptInput, StartExplore } from "./StartPrompt";
import type { Dataset, Starter } from "./schema";
import styles from "./StartScreen.module.css";

/**
 * The Start screen. A server component: the dataset and the starters are
 * introspected per request by the route and passed in, so nothing here is
 * written for a particular table.
 *
 * The fold is the whole screen now — a centred title and the input, nothing
 * else.
 *
 * The placeholder deliberately does NOT name a table. It used to say "Ask
 * anything about <shortName>", which read as though that one table were the
 * dataset — with a dozen of them connected, the name it happened to pick was
 * arbitrary and quietly misleading about what could be asked. It now says the
 * same thing the chat composer says, and points at the @ mention, which is the
 * honest way to narrow to a table.
 */
export function StartScreen({
  dataset,
  starters,
  error,
}: {
  dataset: Dataset | null;
  starters: Starter[];
  error?: string;
}) {
  return (
    <div className={styles.screen}>
      <main className={styles.hero}>
        <div className={styles.heroColumn}>
          <h1 className={styles.headline}>Ask your data in plain language.</h1>
          <PromptInput
            placeholder={
              dataset
                ? "Ask anything about your data, or @ a table…"
                : "No dataset connected"
            }
            disabled={!dataset}
          />
          {dataset ? <StartExplore /> : null}
        </div>
      </main>
    </div>
  );
}

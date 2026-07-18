import { PromptInput, StartExplore } from "./StartPrompt";
import type { Dataset, Starter } from "./schema";
import styles from "./StartScreen.module.css";

/**
 * The Start screen. A server component: the dataset and the starters are
 * introspected per request by the route and passed in, so nothing here is
 * written for a particular table.
 *
 * The fold is the whole screen now — a centred title and the input, nothing
 * else. Which dataset a thread is pointed at, and scoping it to one table, lives
 * inside the chat as the table selector; the placeholder already names it.
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
              dataset ? `Ask anything about ${dataset.shortName}…` : "No dataset connected"
            }
            disabled={!dataset}
          />
          {dataset ? <StartExplore /> : null}
        </div>
      </main>
    </div>
  );
}

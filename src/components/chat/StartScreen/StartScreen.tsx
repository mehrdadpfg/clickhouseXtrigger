import { Card, Chip } from "@/components/ui";
import { PromptInput } from "./StartPrompt";
import type { Dataset, Starter } from "./schema";
import styles from "./StartScreen.module.css";

/**
 * The Start screen. A server component: the dataset and the starters are
 * introspected per request by the route and passed in, so nothing here is
 * written for a particular table.
 *
 * `dataset: null` is the honest empty state — ClickHouse answered, and has no
 * user tables. `error` is the other one: it didn't answer.
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
      {/* The fold is only the title and the input — everything focuses on the
          one thing you do here. The dataset it is pointed at and the example
          questions move below, reachable on scroll. */}
      <main className={styles.hero}>
        <div className={styles.heroColumn}>
          <h1 className={styles.headline}>Ask your data in plain language.</h1>
          <PromptInput
            placeholder={
              dataset ? `Ask anything about ${dataset.shortName}…` : "No dataset connected"
            }
            disabled={!dataset}
          />
        </div>
      </main>

      <section className={styles.below} aria-label="About this dataset">
        <div className={styles.column}>
          <ConnectionPill dataset={dataset} error={error} />

          {dataset ? <SchemaHint dataset={dataset} /> : null}
        </div>
      </section>
    </div>
  );
}

const NUMBER = new Intl.NumberFormat("en-US");

/** Connected · <table> — plus the live row and column counts beside it. */
function ConnectionPill({
  dataset,
  error,
}: {
  dataset: Dataset | null;
  error?: string;
}) {
  const connected = dataset !== null && error === undefined;

  const facts = dataset
    ? [
        dataset.rows === null
          ? "row count unavailable"
          : `${NUMBER.format(dataset.rows)} rows`,
        `${NUMBER.format(dataset.columnCount)} columns`,
      ].join(" · ")
    : (error ?? "no tables found");

  return (
    <div className={styles.pillRow}>
      <Chip
        label={
          <>
            <span
              className="inline-block size-1.5 shrink-0 rounded-full"
              style={{
                background: connected ? "var(--good)" : "var(--critical)",
              }}
              aria-hidden="true"
            />
            {connected ? `Connected · ${dataset.table}` : "Not connected"}
          </>
        }
      />
      <span className={`${styles.facts} tnum`}>{facts}</span>
    </div>
  );
}

/** The columns themselves, straight off system.columns. */
function SchemaHint({ dataset }: { dataset: Dataset }) {
  return (
    <Card padding="sm" className={styles.hint}>
      <div className={styles.eyebrow}>What&rsquo;s in the data</div>
      <div className="flex flex-wrap gap-[7px]">
        {dataset.chips.map((chip) => (
          // The full ClickHouse type on hover: the chip shows "float", but
          // Nullable(Float32) is the truth and the difference can matter.
          <Chip
            key={chip.name}
            title={chip.type}
            label={
              <>
                {chip.name}{" "}
                <span className="text-[var(--text-muted)]">{chip.label}</span>
              </>
            }
          />
        ))}
        {dataset.overflow > 0 && (
          <span className="px-[5px] py-1 font-mono text-[11px] text-[var(--text-muted)]">
            +{dataset.overflow} more
          </span>
        )}
      </div>
    </Card>
  );
}

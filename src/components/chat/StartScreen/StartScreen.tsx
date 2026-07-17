import { Card, Chip } from "@/components/ui";
import { StartPrompt } from "./StartPrompt";
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
      <main className={styles.hero}>
        <div className={styles.column}>
          <h1 className={styles.headline}>
            Ask your data in plain language. Get real numbers — and the query
            behind them.
          </h1>
          <p className={styles.subcopy}>
            The agent writes SQL, runs it on ClickHouse, shows its work, and can
            keep watching — subscribe to a question and it re-runs in the
            background for you.
          </p>

          <ConnectionPill dataset={dataset} error={error} />

          {dataset ? (
            <>
              <SchemaHint dataset={dataset} />
              <StartPrompt
                starters={starters}
                placeholder={`Ask anything about ${dataset.shortName}…`}
              />
            </>
          ) : (
            <StartPrompt
              starters={starters}
              placeholder="No dataset connected"
              disabled
            />
          )}
        </div>
      </main>
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

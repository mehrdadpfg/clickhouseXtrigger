import {
  deriveStarters,
  StartScreen,
  toDataset,
  type Dataset,
  type Starter,
} from "@/components/chat/StartScreen";
import { describeTable, listTables } from "@/lib/clickhouse/introspect";

/**
 * "/" — Start.
 *
 * An RSC so the schema is read at request time and rendered server-side: the
 * table name, row count and columns below are whatever the configured
 * ClickHouse actually holds. Nothing on this screen is written for a
 * particular dataset.
 */
export const dynamic = "force-dynamic";

/**
 * The dataset the screen is "connected" to.
 *
 * With no configured table name to go on, the biggest one wins: the table an
 * analyst points a tool like this at is the fact table, and the fact table is
 * the one with the rows. Ties and null row counts (views) fall back to the
 * introspection order, which is alphabetical.
 */
function pickDataset<T extends { rows: number | null }>(tables: T[]): T | null {
  return (
    [...tables].sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0))[0] ?? null
  );
}

async function load(): Promise<{
  dataset: Dataset | null;
  starters: Starter[];
  error?: string;
}> {
  try {
    const table = pickDataset(await listTables());
    if (!table) return { dataset: null, starters: [] };

    const schema = await describeTable(table.database, table.name);
    if (!schema) return { dataset: null, starters: [] };

    const dataset = toDataset(schema, schema.columns);
    return { dataset, starters: deriveStarters(dataset, schema.columns) };
  } catch (cause) {
    // A dead ClickHouse is a state to render, not a 500: the screen says
    // "Not connected" and why, rather than showing an error page.
    console.error("Start screen introspection failed", cause);
    return {
      dataset: null,
      starters: [],
      error: cause instanceof Error ? cause.message : "introspection failed",
    };
  }
}

export default async function Page() {
  const { dataset, starters, error } = await load();

  return <StartScreen dataset={dataset} starters={starters} error={error} />;
}

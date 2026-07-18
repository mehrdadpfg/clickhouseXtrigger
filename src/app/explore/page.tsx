import { ExploreStart, toTableChoice, type TableChoice } from "@/components/explore";
import { listTables } from "@/lib/clickhouse/introspect";

/**
 * "/explore" — start an exploration.
 *
 * An RSC: the warehouse's tables are read at request time and mapped to
 * pickable choices server-side, so the connection string never leaves the
 * server and the picker holds only plain data. What relates to what is decided
 * later, by the agent, over the scope the human curates here.
 */
export const dynamic = "force-dynamic";

async function load(): Promise<{ tables: TableChoice[]; error?: string }> {
  try {
    const tables = await listTables();
    return { tables: tables.map(toTableChoice) };
  } catch (cause) {
    // A dead ClickHouse is a state to render, not a 500 — the screen says why.
    console.error("Explore table listing failed", cause);
    return {
      tables: [],
      error: cause instanceof Error ? cause.message : "introspection failed",
    };
  }
}

export default async function ExplorePage() {
  const { tables, error } = await load();
  return <ExploreStart tables={tables} error={error} />;
}

import { clickhouse, READONLY_SETTINGS } from "./client";

/**
 * Runs a single stored SELECT and returns its rows.
 *
 * The SQL is never taken from the browser — a board tile stores it, and the
 * server actions run it by tile id. Every run is guarded by READONLY_SETTINGS,
 * so a hand-edited tile still cannot mutate, exceed the row cap, or run long.
 *
 * Server-only: never import from a "use client" module.
 */
export async function runReadonlyQuery(
  sql: string,
): Promise<Record<string, unknown>[]> {
  const resultSet = await clickhouse.query({
    query: sql,
    format: "JSONEachRow",
    clickhouse_settings: READONLY_SETTINGS,
  });
  return await resultSet.json<Record<string, unknown>>();
}

/** What a run cost, read off ClickHouse's own summary. */
export type QueryCost = {
  /** Seconds the server spent. */
  elapsed: number;
  rowsRead: number;
  bytesRead: number;
};

/**
 * Like runReadonlyQuery, but also reports what the query cost.
 *
 * On a table of a few hundred million rows the gap between a query that hits
 * the primary key and one that doesn't is milliseconds versus tens of gigabytes
 * scanned, and nothing in the UI said which had just happened. ClickHouse
 * reports it in the x-clickhouse-summary response header.
 *
 * The header is advisory: it can be absent or partial depending on the format
 * and the server, so a missing summary yields null rather than zeros — "we
 * don't know" and "it scanned nothing" must not look the same.
 */
export async function runReadonlyQueryWithCost(
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; cost: QueryCost | null }> {
  const resultSet = await clickhouse.query({
    query: sql,
    format: "JSONEachRow",
    clickhouse_settings: READONLY_SETTINGS,
  });
  const rows = await resultSet.json<Record<string, unknown>>();

  const raw = resultSet.response_headers["x-clickhouse-summary"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return { rows, cost: null };

  try {
    const summary = JSON.parse(header) as Record<string, string>;
    // Every field arrives as a string; elapsed is in nanoseconds.
    const num = (key: string) => Number(summary[key] ?? "0") || 0;
    return {
      rows,
      cost: {
        elapsed: num("elapsed_ns") / 1e9,
        rowsRead: num("read_rows"),
        bytesRead: num("read_bytes"),
      },
    };
  } catch {
    return { rows, cost: null };
  }
}

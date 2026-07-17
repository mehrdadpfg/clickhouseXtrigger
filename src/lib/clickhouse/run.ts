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

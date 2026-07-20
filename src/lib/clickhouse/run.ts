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

/** One query's outcome inside a batch. Mirrors the tile-level TileResult. */
export type ReadonlyQueryResult =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; error: string };

/**
 * Below the ClickHouse client's default connection pool of 10, so a board load
 * cannot starve every other request in flight — chat, /explore and the query log
 * all draw from the same pool, and a board that saturated it would make the rest
 * of the app appear hung rather than merely slow.
 */
const DEFAULT_CONCURRENCY = 6;

/**
 * Runs many stored SELECTs at once and returns their results positionally.
 *
 * Three properties the callers depend on:
 *
 * 1. PER-QUERY ISOLATION. A rejection becomes an `ok: false` entry, never a
 *    thrown batch. One tile whose column was renamed upstream must not blank the
 *    other nine — the board is a set of independent measurements, and a batched
 *    load must not make them fail as a unit just because the transport changed.
 *
 * 2. BOUNDED CONCURRENCY, via a fixed worker pool rather than a chunked
 *    `Promise.all`. Chunking would stall the whole batch on its slowest member
 *    at every boundary; workers pull the next query the moment they are free, so
 *    one 1.5s query overlaps the short ones instead of gating them.
 *
 * 3. DEDUPE of byte-identical SQL, within this call only. Two tiles that pin the
 *    same query — a KPI and the chart beside it — are one round trip. Identity
 *    is exact string equality: normalising whitespace would mean parsing SQL to
 *    be sure two texts really are the same query, and a wrong merge here serves
 *    one tile another tile's rows. Nothing is cached across calls, so a reload
 *    still re-runs everything, which is what "the board runs live" means.
 *
 * Server-only: never import from a "use client" module.
 */
export async function runReadonlyQueries(
  sqls: string[],
  options?: { concurrency?: number },
): Promise<ReadonlyQueryResult[]> {
  const unique = [...new Set(sqls)];
  const bySql = new Map<string, ReadonlyQueryResult>();

  const workers = Math.max(
    1,
    Math.min(options?.concurrency ?? DEFAULT_CONCURRENCY, unique.length),
  );

  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let i = next++; i < unique.length; i = next++) {
        const sql = unique[i]!;
        try {
          bySql.set(sql, { ok: true, rows: await runReadonlyQuery(sql) });
        } catch (cause) {
          bySql.set(sql, {
            ok: false,
            error:
              cause instanceof Error
                ? cause.message
                : "The query did not run. Try again.",
          });
        }
      }
    }),
  );

  // Positional, so the caller can zip results back onto whatever it keyed the
  // SQL by without this function learning what a tile is.
  return sqls.map((sql) => bySql.get(sql)!);
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

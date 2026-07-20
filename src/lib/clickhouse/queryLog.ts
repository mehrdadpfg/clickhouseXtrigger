import { clickhouse } from "./client";

/**
 * Reads system.query_log to find the recurring, expensive work Vantage has been
 * doing against the user's tables — the raw evidence /tune reasons over.
 *
 * ClickHouse already records every query's text, duration and rows read, so
 * this is a read of history that already exists rather than a log we keep
 * ourselves. Grouping by `normalized_query_hash` collapses "the same question
 * asked with different literals" (last week vs this week, zone A vs zone B) into
 * one pattern, which is exactly the unit a materialized view or projection
 * optimizes.
 *
 * Dataset-agnostic by construction: nothing here names a table. What counts as
 * "the user's data" is defined negatively — anything that is not a system
 * database, the information_schema, or an internal `_`-prefixed namespace
 * (e.g. `_table_function.*`). That also excludes our own introspection
 * (reads of system.tables / system.columns) and this very analysis
 * (a read of system.query_log), so /tune never proposes optimizing itself.
 *
 * Server-only: never import from a "use client" module.
 */

export type QueryPattern = {
  /** normalized_query_hash, as a string — it is a UInt64. Stable across reruns. */
  queryHash: string;
  /** A representative, literal-normalized query for this pattern (FORMAT stripped). */
  sampleQuery: string;
  /** The user tables this pattern reads — "database.table". */
  tables: string[];
  /** Executions in the window. This is what makes a pattern "recurring". */
  count: number;
  avgDurationMs: number;
  maxDurationMs: number;
  /** Rows/bytes read across all executions — the total work worth eliminating. */
  totalReadRows: number;
  totalReadBytes: number;
  avgReadRows: number;
  /** Distinct calendar days the pattern ran on. */
  daysActive: number;
  firstSeen: string;
  lastSeen: string;
};

export type QueryLogAnalysis = {
  windowDays: number;
  /**
   * How much history system.query_log actually holds, in minutes.
   *
   * NOT the same as `windowDays`, and usually far smaller. ClickHouse Cloud
   * rotates the query log aggressively — on the service this was built against
   * it retains about 70 minutes, so a "last 14 days" analysis is really an
   * analysis of the last hour. Reporting the requested window as though it were
   * the observed one is how you get "no recurring queries" on a database
   * somebody has been querying all week.
   */
  retainedMinutes: number;
  /** Total matching SELECT executions in the window (not just the top patterns). */
  totalQueries: number;
  /** Distinct patterns behind those executions. */
  distinctPatterns: number;
  /** The heaviest patterns, most total bytes read first. */
  patterns: QueryPattern[];
};

export type AnalyzeQueryLogOptions = {
  /** How far back to look. Defaults to 14 days — the design's window. */
  windowDays?: number;
  /** Max patterns to return. Defaults to 12. */
  limit?: number;
  /** Ignore one-off queries: a pattern must recur at least this many times. */
  minCount?: number;
};

/**
 * The predicate that decides whether one "database.table" string names the
 * *user's* data. A pattern is kept when it reads at least one such table; the
 * exclusions strip system, information_schema and internal `_`-prefixed
 * namespaces — which is also what removes our introspection and this analysis.
 *
 * Parameterised by the lambda variable so the two call sites can use *different*
 * names. They must: ClickHouse's analyzer mis-attributes the aggregate to the
 * WHERE clause ("groupArrayArray is found in WHERE") if a SELECT-side
 * higher-order function reuses the same lambda variable as the WHERE-side one.
 */
function userTable(v: string): string {
  return `(NOT startsWith(${v}, 'system.')
    AND NOT startsWith(${v}, 'INFORMATION_SCHEMA.')
    AND NOT startsWith(${v}, 'information_schema.')
    AND NOT startsWith(${v}, '_'))`;
}

/**
 * Where the query log is read from.
 *
 * On ClickHouse Cloud `system.query_log` is PER-REPLICA, and a client connection
 * lands on whichever replica the load balancer picks. Reading the local table
 * therefore sees only the queries that happened to run on one node — measured on
 * this service, 12,826 rows locally against 29,968 cluster-wide, so less than
 * half the history. That shortfall reads to the user as "you have not been
 * querying much", which is the one conclusion this analysis must never reach by
 * accident.
 *
 * `clusterAllReplicas` fixes it, but does not exist on a single-node OSS server
 * with no cluster named `default`, so the caller falls back on failure.
 */
const CLUSTER_SOURCE = "clusterAllReplicas('default', system.query_log)";
const LOCAL_SOURCE = "system.query_log";

/**
 * The shared WHERE that both queries below filter on. QueryFinish alone already
 * excludes failed and in-flight queries; query_kind pins us to SELECTs.
 */
const MATCHING_ROWS = `
  type = 'QueryFinish'
  AND query_kind = 'Select'
  AND event_time >= now() - toIntervalDay({windowDays:UInt32})
  AND arrayExists(t -> ${userTable("t")}, tables)
`;

type PatternRow = {
  queryHash: string;
  sampleQuery: string;
  tables: string[];
  count: string;
  avgDurationMs: number;
  maxDurationMs: number;
  totalReadRows: string;
  totalReadBytes: string;
  avgReadRows: number;
  daysActive: string;
  firstSeen: string;
  lastSeen: string;
};

type TotalsRow = {
  totalQueries: string;
  distinctPatterns: string;
  retainedMinutes: number;
};

/** UInt64 aggregates arrive as strings in JSONEachRow — coerce, tolerate junk. */
function num(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A logged query keeps its `FORMAT JSONEachRow` tail (that is how the app asked
 * for it) and often a trailing semicolon. Neither belongs in evidence a person
 * reads, so both are trimmed for display. The hash — not this text — is the
 * pattern's identity, so trimming is cosmetic.
 */
function cleanSample(sql: string): string {
  return sql
    .replace(/\s+FORMAT\s+\w+\s*;?\s*$/i, "")
    .replace(/;\s*$/, "")
    .trim();
}

function toPattern(row: PatternRow): QueryPattern {
  return {
    queryHash: row.queryHash,
    sampleQuery: cleanSample(row.sampleQuery),
    tables: Array.isArray(row.tables) ? row.tables : [],
    count: num(row.count),
    avgDurationMs: num(row.avgDurationMs),
    maxDurationMs: num(row.maxDurationMs),
    totalReadRows: num(row.totalReadRows),
    totalReadBytes: num(row.totalReadBytes),
    avgReadRows: num(row.avgReadRows),
    daysActive: num(row.daysActive),
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
  };
}

/**
 * Analyse the query log and return the heaviest recurring SELECT patterns
 * against user tables, plus window-wide totals for the headline.
 */
export async function analyzeQueryLog(
  options: AnalyzeQueryLogOptions = {},
): Promise<QueryLogAnalysis> {
  const windowDays = options.windowDays ?? 14;
  const limit = options.limit ?? 12;
  const minCount = options.minCount ?? 2;

  const params = { windowDays, limit, minCount };

  // Prefer the cluster-wide log; fall back to the local table where there is no
  // `default` cluster to read (single-node OSS). Probed once per call with the
  // cheapest possible read rather than assumed from config, because getting this
  // wrong silently halves the evidence rather than raising anything.
  let source = CLUSTER_SOURCE;
  try {
    await clickhouse.query({
      query: `SELECT 1 FROM ${CLUSTER_SOURCE} LIMIT 1`,
      format: "JSONEachRow",
    });
  } catch {
    source = LOCAL_SOURCE;
  }

  // Two reads, one round trip apart: the ranked patterns, and the window totals
  // (which must count *all* matching executions, not just the ones that made
  // the top LIMIT). Both share MATCHING_ROWS so they can never disagree on what
  // "a user query" is.
  const [patternsSet, totalsSet] = await Promise.all([
    // The array filtering runs in an OUTER query over the aggregated alias, not
    // beside the aggregates. Filtering inside the grouped SELECT (arrayFilter
    // over groupArrayArray next to argMax) trips the analyzer bug described on
    // userTable(); hoisting it one level up sidesteps that entirely.
    clickhouse.query({
      query: `
        SELECT
          queryHash,
          sampleQuery,
          arrayDistinct(arrayFilter(u -> ${userTable("u")}, allTables)) AS tables,
          count, avgDurationMs, maxDurationMs, totalReadRows, totalReadBytes,
          avgReadRows, daysActive, firstSeen, lastSeen
        FROM (
          SELECT
            toString(normalized_query_hash)                    AS queryHash,
            argMax(normalizeQuery(query), query_duration_ms)   AS sampleQuery,
            groupArrayArray(tables)                            AS allTables,
            toString(count())                                  AS count,
            round(avg(query_duration_ms))                      AS avgDurationMs,
            max(query_duration_ms)                             AS maxDurationMs,
            toString(sum(read_rows))                           AS totalReadRows,
            toString(sum(read_bytes))                          AS totalReadBytes,
            round(avg(read_rows))                              AS avgReadRows,
            toString(uniqExact(toDate(event_time)))            AS daysActive,
            toString(min(event_time))                          AS firstSeen,
            toString(max(event_time))                          AS lastSeen,
            sum(read_bytes)                                    AS sortBytes
          FROM ${source}
          WHERE ${MATCHING_ROWS}
          GROUP BY normalized_query_hash
          HAVING count() >= {minCount:UInt32}
          ORDER BY sortBytes DESC
          LIMIT {limit:UInt32}
        )
      `,
      format: "JSONEachRow",
      query_params: params,
    }),
    clickhouse.query({
      query: `
        SELECT
          toString(count())                             AS totalQueries,
          toString(uniqExact(normalized_query_hash))    AS distinctPatterns,
          -- How much history the log actually holds. Measured over ALL rows,
          -- not the filtered ones, because it is a property of the log's
          -- rotation rather than of this analysis.
          (
            SELECT ifNull(dateDiff('minute', min(event_time), max(event_time)), 0)
            FROM ${source}
          )                                             AS retainedMinutes
        FROM ${source}
        WHERE ${MATCHING_ROWS}
      `,
      format: "JSONEachRow",
      query_params: params,
    }),
  ]);

  const patternRows = await patternsSet.json<PatternRow>();
  const totalsRows = await totalsSet.json<TotalsRow>();
  const totals = totalsRows[0];

  return {
    windowDays,
    retainedMinutes: num(totals?.retainedMinutes),
    totalQueries: num(totals?.totalQueries),
    distinctPatterns: num(totals?.distinctPatterns),
    patterns: patternRows.map(toPattern),
  };
}

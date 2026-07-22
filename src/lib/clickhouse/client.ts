import { createClient } from "@clickhouse/client";
import { env } from "@/lib/env";

/**
 * One client per process — createClient opens a connection pool, so creating
 * one per request leaks connections.
 *
 * Server-only: never import from a "use client" module.
 */
export const clickhouse = createClient({
  url: env.CLICKHOUSE_URL,
  application: "vantage",
  // ClickHouse Cloud sits behind a load balancer that reaps idle connections.
  // A query that scans for a while without streaming any bytes back looks idle
  // to the LB, so it drops the connection mid-flight — surfacing on the client
  // as a spurious "Timeout error" / ECONNRESET even though the query was fine
  // (the same full-table aggregation runs in ~2s when it isn't cut off). Turning
  // on progress headers makes the server dribble a keep-alive ping down the open
  // connection every few seconds while it works, so the LB never sees it as idle.
  // This is about the CONNECTION, not the query budget — max_execution_time (30s)
  // below is unchanged; this only stops queries that WOULD finish from being
  // killed by a dropped socket. Applies to every query the app makes.
  clickhouse_settings: {
    send_progress_in_http_headers: 1,
    http_headers_progress_interval_ms: "5000",
  },
});

/**
 * Guards applied to every model-authored query.
 *
 * readonly=2 (not 1) permits SELECTs *and* allows setting the other guards
 * below; readonly=1 would reject the settings themselves.
 */
export const READONLY_SETTINGS = {
  readonly: "2",
  max_execution_time: 30,
  max_result_rows: "500",
  // Truncate rather than erroring when a query returns too much.
  result_overflow_mode: "break",
} as const;

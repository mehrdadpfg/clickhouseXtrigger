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

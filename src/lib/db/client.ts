import { Pool, types } from "pg";
import { env } from "@/lib/env";

/**
 * pg returns NUMERIC and BIGINT as strings, because both can hold values that
 * lose precision as a JS number. Ours can't: a watcher's last_value and an
 * alert's value are metric readings, and our BIGINTs are row counts. Parsing
 * here keeps the row types honest — otherwise `last_value: number` would be a
 * lie and `value > threshold` would silently compare strings.
 *
 * setTypeParser is process-global, which is why it lives with the single pool.
 */
types.setTypeParser(types.builtins.NUMERIC, (v) => Number(v));
types.setTypeParser(types.builtins.INT8, (v) => Number(v));

/**
 * One pool per process. A Pool is a connection pool — creating one per request
 * exhausts the server's connection limit.
 *
 * Server-only: never import from a "use client" module.
 */
export const pool = new Pool({
  host: env.PGHOST,
  port: env.PGPORT,
  user: env.PGUSER,
  password: env.PGPASSWORD,
  database: env.PGDATABASE,
  // ClickHouse Cloud's managed Postgres terminates TLS at a proxy that presents
  // a cert we don't pin, so verification is off but the transport is encrypted.
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/** Tagged query helper. Always pass values as params — never interpolate. */
export async function query<T extends Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

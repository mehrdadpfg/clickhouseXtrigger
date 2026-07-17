/**
 * Migration runner — `bun run db:migrate`.
 *
 * Applies every migrations/*.sql not yet recorded in schema_migrations, in
 * filename order, each in its own transaction. A failed migration rolls back
 * and aborts the run, so the next one never sees a half-applied schema.
 *
 * Checksums are recorded and re-verified: editing an already-applied migration
 * is a mistake that otherwise stays silent until prod diverges from dev.
 */
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pool } from "@/lib/db/client";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

async function main() {
  await pool.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      checksum   text        not null,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migrations found in", MIGRATIONS_DIR);
    return;
  }

  const applied = new Map(
    (
      await pool.query<{ filename: string; checksum: string }>(
        "select filename, checksum from schema_migrations",
      )
    ).rows.map((r) => [r.filename, r.checksum] as const),
  );

  let ran = 0;

  for (const filename of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
    const sum = checksum(sql);
    const previous = applied.get(filename);

    if (previous !== undefined) {
      if (previous !== sum) {
        throw new Error(
          `${filename} was modified after it was applied (checksum ${previous} -> ${sum}).\n` +
            `Migrations are immutable once applied — add a new migration instead.`,
        );
      }
      console.log(`· ${filename} — already applied`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (filename, checksum) values ($1, $2)",
        [filename, sum],
      );
      await client.query("commit");
      console.log(`✓ ${filename} — applied`);
      ran++;
    } catch (error) {
      await client.query("rollback");
      throw new Error(`${filename} failed — rolled back.\n${String(error)}`);
    } finally {
      client.release();
    }
  }

  console.log(
    ran === 0 ? "Up to date — nothing to apply." : `Applied ${ran} migration(s).`,
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // Without this the pool keeps the event loop alive and the script hangs.
  await pool.end();
}

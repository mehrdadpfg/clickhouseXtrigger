/**
 * Alerts — a watcher tripped its threshold.
 *
 * Append-only: a fired alert is a historical fact. `acknowledged` is the only
 * mutable field. Deleting a watcher cascades its alerts away.
 *
 * Server-only. Every value is passed as a bind parameter — never interpolated.
 */
import { query } from "@/lib/db/client";
import type { AlertRow } from "@/types/db";

const COLUMNS = "id, watcher_id, fired_at, value, message, acknowledged";

/** The "Recent alerts" feed. */
export async function listAlerts(limit = 20): Promise<AlertRow[]> {
  return query<AlertRow>(
    `select ${COLUMNS} from alerts order by fired_at desc limit $1`,
    [limit],
  );
}

export async function listAlertsForWatcher(
  watcherId: string,
  limit = 20,
): Promise<AlertRow[]> {
  return query<AlertRow>(
    `select ${COLUMNS} from alerts
     where watcher_id = $1
     order by fired_at desc
     limit $2`,
    [watcherId, limit],
  );
}

export async function getAlert(id: string): Promise<AlertRow | null> {
  const rows = await query<AlertRow>(
    `select ${COLUMNS} from alerts where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createAlert(input: {
  watcherId: string;
  message: string;
  value?: number | null;
  firedAt?: Date;
}): Promise<AlertRow> {
  const rows = await query<AlertRow>(
    `insert into alerts (watcher_id, message, value, fired_at)
     values ($1, $2, $3, coalesce($4, now()))
     returning ${COLUMNS}`,
    [input.watcherId, input.message, input.value ?? null, input.firedAt ?? null],
  );
  return rows[0]!;
}

export async function acknowledgeAlert(id: string): Promise<AlertRow | null> {
  const rows = await query<AlertRow>(
    `update alerts set acknowledged = true where id = $1 returning ${COLUMNS}`,
    [id],
  );
  return rows[0] ?? null;
}

/** Bulk "mark all read". Returns the number actually flipped. */
export async function acknowledgeAllAlerts(): Promise<number> {
  const rows = await query<{ id: string }>(
    `update alerts set acknowledged = true where not acknowledged returning id`,
  );
  return rows.length;
}

/** Unread badge count. */
export async function countUnacknowledgedAlerts(): Promise<number> {
  const rows = await query<{ count: number }>(
    `select count(*)::bigint as count from alerts where not acknowledged`,
  );
  return rows[0]?.count ?? 0;
}

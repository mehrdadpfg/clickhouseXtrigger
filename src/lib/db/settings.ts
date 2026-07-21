/**
 * App settings — global, install-wide preferences.
 *
 * One row, guaranteed by the schema (see migration 006): the boolean primary
 * key is CHECKed true, so there is only ever `id = true`. The seed insert in the
 * migration means the row always exists, but reads still coalesce to a safe
 * default so a fresh database (migration not yet applied) degrades to "off"
 * rather than throwing.
 *
 * Server-only. Every value is passed as a bind parameter — never interpolated.
 */
import { query } from "@/lib/db/client";
import type { AppSettingsRow } from "@/types/db";

const COLUMNS = "id, default_notify_email, updated_at";

/** The whole settings row, or null on a database that has never been seeded. */
export async function getAppSettings(): Promise<AppSettingsRow | null> {
  const rows = await query<AppSettingsRow>(
    `select ${COLUMNS} from app_settings where id = true`,
  );
  return rows[0] ?? null;
}

/**
 * The fallback recipient for any watcher without its own notify_email. Null when
 * unset — the tick reads this as "no default", and email notifications for such
 * watchers are simply off.
 */
export async function getDefaultNotifyEmail(): Promise<string | null> {
  const settings = await getAppSettings();
  return settings?.default_notify_email ?? null;
}

/**
 * Persist the global default recipient. An empty string clears it (back to off);
 * upsert so a database whose seed row somehow went missing still lands a value.
 */
export async function setDefaultNotifyEmail(
  email: string | null,
): Promise<AppSettingsRow> {
  const value = email && email.trim() !== "" ? email.trim() : null;
  const rows = await query<AppSettingsRow>(
    `insert into app_settings (id, default_notify_email, updated_at)
     values (true, $1, now())
     on conflict (id)
       do update set default_notify_email = excluded.default_notify_email,
                     updated_at = now()
     returning ${COLUMNS}`,
    [value],
  );
  return rows[0]!;
}

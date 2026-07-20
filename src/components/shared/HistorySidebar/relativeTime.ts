/**
 * The sidebar's time column: "now", "14m", "2h", "yesterday", "Mon", "Jul 9".
 *
 * Formatted on the server, at request time, and shipped as a finished string —
 * so the markup React hydrates is the markup the server sent. Computing it in
 * the browser instead would render "2h" on the server and "3h" on a client
 * whose clock or timezone disagrees, which is a hydration mismatch.
 *
 * The corollary: the day boundaries below are the *server's*. A chat written at
 * 23:00 in the reader's timezone can read as "yesterday" if the server rolled
 * over first. Fixing that needs the reader's timezone, which is only knowable
 * client-side — deliberately not traded for a hydration mismatch here.
 */

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 86_400_000;

/** Midnight local to the running process — the unit "yesterday" is counted in. */
function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

export function relativeTime(at: Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - at.getTime();

  // A clock skew between Postgres and this process can date a row slightly in
  // the future; "now" is a better answer than "-1m".
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;

  // Elapsed hours, not calendar days: 23:30 seen at 00:30 is "1h", not
  // "yesterday", even though the date changed between them.
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;

  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 1) return "yesterday";
  if (days < 7) return WEEKDAY.format(at);
  return MONTH_DAY.format(at);
}

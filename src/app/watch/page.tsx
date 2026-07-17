import {
  Watchers,
  toAlertView,
  toWatcherView,
  watcherStatus,
  type AlertView,
  type WatchActions,
  type WatcherView,
} from "@/components/watch";
import { listAlerts, listAlertsForWatcher } from "@/lib/db/alerts";
import { listWatchers } from "@/lib/db/watchers";
import {
  acknowledgeAlertAction,
  createWatcherAction,
  deleteWatcherAction,
  setWatcherStateAction,
  updateWatcherAction,
} from "./actions";

/**
 * "/watch" — Watchers.
 *
 * An RSC: watchers and alerts are read at request time and rendered
 * server-side, including every relative timestamp (see components/watch/model).
 *
 * The actions are handed to the components as props rather than imported by
 * them. That keeps dependencies pointing app -> components -> lib, and keeps
 * lib/db — which holds the connection string — out of anything that ships to a
 * browser.
 */
export const dynamic = "force-dynamic";

const actions: WatchActions = {
  setState: setWatcherStateAction,
  remove: deleteWatcherAction,
  create: createWatcherAction,
  update: updateWatcherAction,
  acknowledge: acknowledgeAlertAction,
};

async function load(): Promise<{
  watchers: WatcherView[];
  alerts: AlertView[];
  error?: string;
}> {
  try {
    // One clock for the whole render, so two "2m ago"s on the same page cannot
    // disagree because the second one was formatted a second later.
    const now = new Date();

    const [rows, alertRows] = await Promise.all([listWatchers(), listAlerts(9)]);

    // The hero says "fired 2m ago", which is the last *alert*, not the last
    // run. Fetched per firing watcher rather than mined out of the feed above:
    // that feed is capped at 9, and a watcher's last trip can easily be older
    // than the nine most recent alerts overall. Firing watchers are few by
    // definition, so this stays a handful of indexed lookups.
    const firing = rows.filter((row) => watcherStatus(row) === "firing");
    const firedAt = new Map(
      await Promise.all(
        firing.map(
          async (row) =>
            [
              row.id,
              (await listAlertsForWatcher(row.id, 1))[0]?.fired_at ?? null,
            ] as const,
        ),
      ),
    );

    const byId = new Map(rows.map((row) => [row.id, row]));

    return {
      watchers: rows.map((row) =>
        toWatcherView(row, { firedAt: firedAt.get(row.id), now }),
      ),
      alerts: alertRows.map((alert) =>
        toAlertView(alert, byId.get(alert.watcher_id), now),
      ),
    };
  } catch (cause) {
    // A dead Postgres is a state to render, not a 500 — same call the Start
    // screen makes about a dead ClickHouse.
    console.error("Watchers page load failed", cause);
    return {
      watchers: [],
      alerts: [],
      error:
        cause instanceof Error
          ? `Could not reach the watcher store: ${cause.message}`
          : "Could not reach the watcher store.",
    };
  }
}

export default async function WatchPage() {
  const { watchers, alerts, error } = await load();

  return (
    <Watchers
      watchers={watchers}
      alerts={alerts}
      actions={actions}
      error={error}
    />
  );
}

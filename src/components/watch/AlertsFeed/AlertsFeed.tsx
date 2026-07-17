"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { AlertView, WatchActions } from "../model";
import styles from "./AlertsFeed.module.css";

/**
 * Recent alerts — what tripped, when, and from which question.
 *
 * The design showed three tones (⚠ / ▲ / ✓, the last being "recovered"). The
 * schema has no severity column and no recovery event: an alert row *is* a
 * threshold trip, full stop. So tone here encodes the one real distinction the
 * data carries — `acknowledged`. Unread trips are critical and bright; read
 * ones go quiet. That reproduces the design's one-bright-card-then-dimmer
 * rhythm without inventing a severity nobody stored.
 */
export function AlertsFeed({
  alerts,
  actions,
}: {
  alerts: AlertView[];
  actions: WatchActions;
}) {
  if (alerts.length === 0) {
    return (
      <p className={styles.empty}>
        Nothing has tripped yet. Alerts land here when a watcher crosses its
        threshold.
      </p>
    );
  }

  return (
    <ul className={styles.grid}>
      {alerts.map((alert) => (
        <AlertCard key={alert.id} alert={alert} actions={actions} />
      ))}
    </ul>
  );
}

function AlertCard({
  alert,
  actions,
}: {
  alert: AlertView;
  actions: WatchActions;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const unread = !alert.acknowledged;

  function acknowledge() {
    startTransition(async () => {
      const result = await actions.acknowledge(alert.id);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <li className={`${styles.card} ${unread ? styles.unread : styles.read}`}>
      <div className={styles.head}>
        {/* Redundant with the colour, on purpose — status is never carried by
            colour alone. */}
        <span className={styles.icon} aria-hidden="true">
          {unread ? "⚠" : "✓"}
        </span>
        <span className={styles.message}>{alert.message}</span>
        <span className="sr-only">{unread ? " (unread)" : " (read)"}</span>

        {alert.chatId ? (
          <Link href={`/chats/${alert.chatId}`} className={styles.jump}>
            jump <span aria-hidden="true">→</span>
            <span className="sr-only"> to {alert.source}</span>
          </Link>
        ) : null}
      </div>

      <div className={`tnum ${styles.meta}`}>
        <span>
          {alert.stamp} · {alert.source}
        </span>
        {unread ? (
          <button
            type="button"
            className={styles.ack}
            onClick={acknowledge}
            disabled={pending}
          >
            mark read
          </button>
        ) : null}
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

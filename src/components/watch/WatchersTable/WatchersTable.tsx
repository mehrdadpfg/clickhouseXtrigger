"use client";

import Link from "next/link";
import { useState } from "react";
import { STATUS_LABEL, type WatchActions, type WatcherView } from "../model";
import { WatcherControls } from "../WatcherControls/WatcherControls";
import styles from "./WatchersTable.module.css";

/**
 * Every watcher, firing first.
 *
 * Hand-rolled rather than built on ui/DataTable: that primitive renders
 * arbitrary query results, and has no notion of a row whose *state* changes how
 * the row reads. Here the state is the point — a paused row is dimmed and its
 * number is frozen — so the markup is domain-specific and lives here.
 *
 * The design also carried a Trend sparkline per row. There is no run history in
 * the schema (a watcher stores `last_value`, one number, and alerts only record
 * the trips), so there is no series to draw. Drawing one anyway would be
 * inventing data; the column is omitted until something records runs.
 */
export function WatchersTable({
  watchers,
  actions,
}: {
  watchers: WatcherView[];
  actions: WatchActions;
}) {
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <div className={styles.frame}>
        <table className={styles.table}>
          <caption className="sr-only">
            All watchers, firing first, then most recently run.
          </caption>
          <thead>
            <tr>
              <th scope="col" className={styles.th}>
                Status
              </th>
              <th scope="col" className={styles.th}>
                Watcher
              </th>
              <th scope="col" className={`${styles.th} ${styles.right}`}>
                Current
              </th>
              <th scope="col" className={styles.th}>
                Every
              </th>
              <th scope="col" className={styles.th}>
                Last run
              </th>
              <th scope="col" className={styles.th}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>

          <tbody className="tnum">
            {watchers.length === 0 ? (
              <tr>
                <td className={styles.empty} colSpan={6}>
                  No watchers yet. Subscribe to a question and it re-runs here in
                  the background.
                </td>
              </tr>
            ) : (
              watchers.map((watcher) => (
                <Row
                  key={watcher.id}
                  watcher={watcher}
                  actions={actions}
                  onError={setError}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {error ? (
        <p className={styles.actionError} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function Row({
  watcher,
  actions,
  onError,
}: {
  watcher: WatcherView;
  actions: WatchActions;
  onError: (message: string) => void;
}) {
  const { status } = watcher;

  const classes = [
    styles.row,
    status === "firing" ? styles.rowFiring : null,
    // Paused is dimmed on purpose: the row is still true, but nothing on it is
    // being refreshed, and it should not compete with the rows that are.
    status === "paused" ? styles.rowPaused : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <tr className={classes}>
      <td className={styles.td}>
        <span className={`${styles.status} ${styles[status]}`}>
          <span
            className={`${styles.dot} ${watcher.isLive ? styles.dotLive : ""}`}
            aria-hidden="true"
          />
          {STATUS_LABEL[status]}
        </span>
      </td>

      <td className={`${styles.td} ${styles.name}`}>
        {watcher.chatId ? (
          <Link href={`/chats/${watcher.chatId}`} className={styles.link}>
            {watcher.question}
          </Link>
        ) : (
          watcher.question
        )}
      </td>

      <td className={`${styles.td} ${styles.right}`}>
        <span
          className={`${styles.reading} ${
            status === "firing" ? styles.readingFiring : ""
          } ${watcher.isLive ? "" : styles.readingFrozen}`}
          // Frozen readings are stamped so a stale number cannot pass for a
          // current one on hover or to a screen reader.
          title={
            watcher.isLive
              ? `${watcher.thresholdNote} · re-runs ${watcher.cadencePhrase}`
              : `Frozen snapshot · ${watcher.thresholdNote}`
          }
        >
          {watcher.isLive ? null : (
            <span className={styles.frozenMark} aria-hidden="true">
              ◷
            </span>
          )}
          {watcher.reading}
        </span>
      </td>

      <td className={`${styles.td} ${styles.muted}`}>{watcher.cadence}</td>
      <td className={`${styles.td} ${styles.muted}`}>{watcher.lastRun}</td>

      <td className={`${styles.td} ${styles.right}`}>
        <WatcherControls
          watcher={watcher}
          actions={actions}
          onError={onError}
        />
      </td>
    </tr>
  );
}

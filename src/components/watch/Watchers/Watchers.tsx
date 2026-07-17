import { AlertsFeed } from "../AlertsFeed/AlertsFeed";
import { FiringHero } from "../FiringHero/FiringHero";
import { NewWatcherButton } from "../NewWatcherButton/NewWatcherButton";
import { WatchersTable } from "../WatchersTable/WatchersTable";
import type { AlertView, WatchActions, WatcherView } from "../model";
import styles from "./Watchers.module.css";

/**
 * The Watchers screen.
 *
 * A server component: every string it renders was formatted by the route at
 * request time. The interactive bits below it are the client islands.
 */
export function Watchers({
  watchers,
  alerts,
  actions,
  error,
}: {
  watchers: WatcherView[];
  alerts: AlertView[];
  actions: WatchActions;
  /** Postgres did not answer. A state to render, not a 500. */
  error?: string;
}) {
  const firing = watchers.filter((w) => w.status === "firing");
  const running = watchers.filter((w) => w.status !== "paused").length;

  return (
    <main className={styles.page}>
      <div className={styles.column}>
        <header className={styles.head}>
          <h1 className={styles.title}>Watchers</h1>
          <span className={`tnum ${styles.pill}`}>
            {running} running · {firing.length} firing
          </span>
          <span className={styles.note}>
            standing queries · re-run in the background via trigger.dev
          </span>
          <NewWatcherButton actions={actions} />
        </header>

        <p className={styles.lede}>
          Watchers live outside any single chat. Create one from any chart
          without leaving the thread — manage, pause, and see fired alerts here.
        </p>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        {/* Only when something is firing. An empty "all clear" card would be a
            permanent fixture that means nothing, and the hero's whole job is
            that its presence is the signal. */}
        {firing.map((watcher) => (
          <FiringHero key={watcher.id} watcher={watcher} actions={actions} />
        ))}

        <h2 className={styles.eyebrow}>All watchers</h2>
        <WatchersTable watchers={watchers} actions={actions} />

        <h2 className={`${styles.eyebrow} ${styles.eyebrowSpaced}`}>
          Recent alerts
        </h2>
        <AlertsFeed alerts={alerts} actions={actions} />
      </div>
    </main>
  );
}

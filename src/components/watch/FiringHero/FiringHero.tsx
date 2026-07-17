"use client";

import Link from "next/link";
import { useState } from "react";
import { Reading } from "../Reading/Reading";
import { WatcherControls } from "../WatcherControls/WatcherControls";
import type { WatchActions, WatcherView } from "../model";
import styles from "./FiringHero.module.css";

/**
 * The card that only exists when something is wrong.
 *
 * The route renders one per firing watcher rather than only the first: hiding
 * the second thing that broke, on the screen whose job is to tell you things
 * broke, would be a strange kind of tidiness. With the usual one firing it is
 * the design's single card exactly.
 *
 * The number is a *living* reading (Design Reference) — the background sweep is
 * still re-running it, which is how it went red in the first place.
 */
export function FiringHero({
  watcher,
  actions,
}: {
  watcher: WatcherView;
  actions: WatchActions;
}) {
  const [error, setError] = useState<string | null>(null);

  return (
    // Deliberately not a live region. aria-live announces *mutations* to a
    // region that was already in the DOM when the reader arrived; this card is
    // inserted and removed wholesale by a server re-render, which it would not
    // reliably announce. The heading below is what actually makes it findable.
    <section className={styles.card} aria-labelledby={`firing-${watcher.id}`}>
      <header className={styles.head}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.firing}>FIRING</span>
        <h2 id={`firing-${watcher.id}`} className={styles.question}>
          {watcher.question}
        </h2>
        <span className={`tnum ${styles.fired}`}>
          {watcher.firedAgo ? `fired ${watcher.firedAgo}` : "firing now"}
        </span>
      </header>

      <div className={styles.body}>
        <Reading
          mode="living"
          tone="critical"
          bare
          value={watcher.reading}
          cadencePhrase={`re-runs ${watcher.cadencePhrase}`}
          stamp={`checked ${watcher.lastRun}`}
          note={watcher.thresholdNote}
          className={styles.reading}
        />

        <div className={styles.actions}>
          {/* A watcher outlives the thread it was born in, so the jump is only
              offered while that thread still exists. */}
          {watcher.chatId ? (
            <Link href={`/chats/${watcher.chatId}`} className={styles.jump}>
              Open thread <span aria-hidden="true">→</span>
            </Link>
          ) : null}
          <WatcherControls
            watcher={watcher}
            actions={actions}
            tone="critical"
            onError={setError}
          />
        </div>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

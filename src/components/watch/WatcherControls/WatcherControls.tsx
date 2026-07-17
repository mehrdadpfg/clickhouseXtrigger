"use client";

import { useMemo, useState, useTransition } from "react";
import { WatchModal } from "../WatchModal/WatchModal";
import type { WatchActions, WatcherView } from "../model";
import styles from "./WatcherControls.module.css";

/**
 * Edit, pause / resume and delete. The hero card and the table both need these
 * and both need them to behave identically, so they share one component rather
 * than two copies that drift.
 *
 * The actions arrive as props. This is a client component, so it cannot reach
 * lib/db itself — and it should not know that Postgres is what is on the other
 * end of `onError`.
 */
export function WatcherControls({
  watcher,
  actions,
  tone = "neutral",
  onError,
}: {
  watcher: WatcherView;
  actions: WatchActions;
  /** `critical` tints the buttons for the firing hero card. */
  tone?: "neutral" | "critical";
  onError?: (message: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const paused = watcher.status === "paused";

  // Keyed by id so the modal's open-effect only re-seeds when the watcher
  // actually changes, not on every parent re-render.
  const editTarget = useMemo(
    () => ({ id: watcher.id, ...watcher.draft }),
    [watcher.id, watcher.draft],
  );

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok && result.error) onError?.(result.error);
    });
  }

  function toggle() {
    run(() => actions.setState(watcher.id, paused ? "active" : "paused"));
  }

  function remove() {
    // Deleting a watcher cascades its alert history away and there is no undo,
    // so the destructive path asks. window.confirm is keyboard-accessible and
    // unskippable, which is what this needs to be.
    const ok = window.confirm(
      `Delete "${watcher.question}"? Its alert history goes with it. This cannot be undone.`,
    );
    if (!ok) return;
    run(() => actions.remove(watcher.id));
  }

  const classes = [styles.controls, tone === "critical" ? styles.critical : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <button
        type="button"
        className={styles.button}
        onClick={() => setEditing(true)}
        disabled={pending}
        aria-label={`Edit ${watcher.question}`}
        title="Edit"
      >
        <span aria-hidden="true">✎</span>
      </button>

      <button
        type="button"
        className={styles.button}
        onClick={toggle}
        disabled={pending}
        // Icon-only: the glyph is decorative and the name lives in the label.
        aria-label={
          paused ? `Resume ${watcher.question}` : `Pause ${watcher.question}`
        }
        title={paused ? "Resume" : "Pause"}
      >
        <span aria-hidden="true">{paused ? "▷" : "⏸"}</span>
      </button>

      <button
        type="button"
        className={`${styles.button} ${styles.danger}`}
        onClick={remove}
        disabled={pending}
        aria-label={`Delete ${watcher.question}`}
        title="Delete"
      >
        <span aria-hidden="true">✕</span>
      </button>

      {/* The modal portals to the body, so nesting it inside a table cell here
          is safe — its DOM position never touches the row's. */}
      <WatchModal
        open={editing}
        onClose={() => setEditing(false)}
        actions={actions}
        initial={editTarget}
      />
    </div>
  );
}

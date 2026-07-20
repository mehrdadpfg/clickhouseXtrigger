"use client";

import { useMemo, useState, useTransition } from "react";
import { EditWatcherModal } from "../EditWatcherModal/EditWatcherModal";
import type { WatchActions, WatcherView } from "../model";
import styles from "./WatcherControls.module.css";
import { Tooltip } from "@/components/ui";

/**
 * Edit and pause / resume. The hero card and the table both need these and both
 * need them to behave identically, so they share one component rather than two
 * copies that drift.
 *
 * Delete moved onto the editor. It used to sit here as a third button, but the
 * watcher now edits on the ChartStudio (EditWatcherModal), and — as with the
 * board tile editor — its Delete lives in that surface's footer, confirmed,
 * beside Save. Keeping a second delete on the row would be two doors to the same
 * irreversible thing.
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

  const classes = [styles.controls, tone === "critical" ? styles.critical : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <Tooltip label="Edit">
        <button
          type="button"
          className={styles.button}
          onClick={() => setEditing(true)}
          disabled={pending}
          aria-label={`Edit ${watcher.question}`}
        >
          <span aria-hidden="true">✎</span>
        </button>
      </Tooltip>

      <Tooltip label={paused ? "Resume" : "Pause"}>
        <button
          type="button"
          className={styles.button}
          onClick={toggle}
          disabled={pending}
          // Icon-only: the glyph is decorative and the name lives in the label.
          aria-label={
            paused ? `Resume ${watcher.question}` : `Pause ${watcher.question}`
          }
        >
          <span aria-hidden="true">{paused ? "▷" : "⏸"}</span>
        </button>
      </Tooltip>

      {/* The modal portals to the body, so nesting it inside a table cell here
          is safe — its DOM position never touches the row's. */}
      <EditWatcherModal
        open={editing}
        onClose={() => setEditing(false)}
        actions={actions}
        watcher={editTarget}
      />
    </div>
  );
}

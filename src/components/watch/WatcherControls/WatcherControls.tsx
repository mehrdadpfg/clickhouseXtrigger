"use client";

import { useMemo, useTransition } from "react";
import { useWatchEditor } from "../WatchWorkspace/WatchWorkspace";
import type { WatchActions, WatcherView } from "../model";
import styles from "./WatcherControls.module.css";
import { Tooltip } from "@/components/ui";

/**
 * Edit and pause / resume. The hero card and the table both need these and both
 * need them to behave identically, so they share one component rather than two
 * copies that drift.
 *
 * Edit opens the watcher in the list's push panel (WatchWorkspace), the board's
 * move rather than a modal. The panel lives once at the list level, so Edit does
 * not render it here — it reaches the panel through WatchWorkspace's context,
 * which is why the button has nothing to open (and is disabled) outside that host.
 *
 * Delete moved onto the editor. It used to sit here as a third button, but the
 * watcher now edits on the ChartStudio (WatcherEditor), and — as with the board
 * tile editor — its Delete lives in that surface's footer, confirmed, beside
 * Save. Keeping a second delete on the row would be two doors to the same
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
  const openEditor = useWatchEditor();
  const paused = watcher.status === "paused";

  // The editable values the panel opens pre-filled with — the same shape the
  // create form collects, keyed by id for the update action. Memoised so its
  // identity is stable across a parent re-render.
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
          onClick={() => openEditor?.(editTarget)}
          disabled={pending || openEditor === null}
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
    </div>
  );
}

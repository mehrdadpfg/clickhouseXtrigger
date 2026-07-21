"use client";

import { Button } from "@/components/ui/Button";
import { useWatchCreator } from "../WatchWorkspace/WatchWorkspace";

/**
 * The "New watcher" trigger. Nothing more: the create form used to live here as a
 * Modal (WatchModal), but a watcher is now created ON the list's push panel — the
 * same ChartStudio surface its edit uses — so the form moved to WatcherCreator and
 * this is just the button that opens the panel.
 *
 * The workspace owns which panel is open (create or an edit, never both), so the
 * click reaches it through context rather than opening anything here. Rendered
 * outside a WatchWorkspace the handle is null and the button is inert, which the
 * list never does.
 *
 * A watcher is normally born from a chart in a thread, where the metric comes
 * bound. Created from this page there is nothing to bind, so the creator asks for
 * the question and SQL itself.
 */
export function NewWatcherButton() {
  const openCreate = useWatchCreator();

  return (
    <Button
      variant="primary"
      size="sm"
      icon="＋"
      onClick={() => openCreate?.()}
      disabled={!openCreate}
    >
      New watcher
    </Button>
  );
}

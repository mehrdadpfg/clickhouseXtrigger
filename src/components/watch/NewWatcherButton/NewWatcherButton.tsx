"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { WatchModal } from "../WatchModal/WatchModal";
import type { WatchActions } from "../model";

/**
 * The only client state on the Watchers header: is the modal open.
 *
 * The modal lives here rather than in the page so the page can stay a server
 * component — everything else it renders is already-formatted strings.
 *
 * A watcher is normally born from a chart in a thread, where the metric comes
 * bound. Created from this page there is nothing to bind, so the modal asks for
 * the question and SQL itself.
 */
export function NewWatcherButton({ actions }: { actions: WatchActions }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="primary" size="sm" icon="＋" onClick={() => setOpen(true)}>
        New watcher
      </Button>
      <WatchModal open={open} onClose={() => setOpen(false)} actions={actions} />
    </>
  );
}

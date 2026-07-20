"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { PushLayout, PushPanel } from "@/components/shared/PushPanel";
import { WatcherEditor } from "../WatcherEditor/WatcherEditor";
import type { WatchActions, WatcherEdit } from "../model";

/**
 * The handle a list control uses to open the editor in the push panel.
 *
 * Distributed by context rather than threaded as a prop because the Edit button
 * lives deep in the list — inside a table row's WatcherControls, and inside the
 * firing hero's — while the panel it drives lives once at the list level. A
 * shared context lets any of those controls ask for the panel without every
 * layer between forwarding a callback it does not otherwise use.
 */
const WatchEditorContext = createContext<((watcher: WatcherEdit) => void) | null>(
  null,
);

/**
 * The Edit button's handle on the panel. Null outside a WatchWorkspace, so a
 * control rendered there simply has nothing to open rather than throwing.
 */
export function useWatchEditor(): ((watcher: WatcherEdit) => void) | null {
  return useContext(WatchEditorContext);
}

/**
 * The Watchers screen's push-panel host.
 *
 * The board move, brought to the watch list: the list is the main content that
 * SHRINKS as the panel takes width (see components/shared/PushPanel), and editing
 * a watcher opens the ChartStudio surface on the right rather than over the page
 * in a modal. The list stays a server-rendered subtree passed straight through as
 * `children` — this shell adds only the panel and the editing state the list's
 * Edit buttons reach through context, so the page keeps formatting its strings on
 * the server exactly as before.
 *
 * Esc closes the panel, wired HERE because PushPanel is pure layout and leaves
 * open/close to the host, the same way the chat and the board do. The delete
 * confirmation inside the editor is its own small ui/Modal and swallows Esc first.
 */
export function WatchWorkspace({
  actions,
  children,
}: {
  actions: WatchActions;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState<WatcherEdit | null>(null);
  const open = useCallback((watcher: WatcherEdit) => setEditing(watcher), []);
  const close = useCallback(() => setEditing(null), []);

  useEffect(() => {
    if (editing === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, close]);

  return (
    <WatchEditorContext.Provider value={open}>
      <PushLayout>
        {children}

        {/* One editor for the whole list, seeded with whichever watcher is being
            edited. The studio toolbar carries the close (showClose={false}), so
            the panel draws none of its own. Empty when nothing is being edited,
            so it collapses to width:0 and the list returns to full width. */}
        <PushPanel
          open={editing !== null}
          onClose={close}
          label="Edit watcher"
          showClose={false}
        >
          {editing ? (
            <WatcherEditor
              key={editing.id}
              watcher={editing}
              actions={actions}
              onClose={close}
            />
          ) : null}
        </PushPanel>
      </PushLayout>
    </WatchEditorContext.Provider>
  );
}

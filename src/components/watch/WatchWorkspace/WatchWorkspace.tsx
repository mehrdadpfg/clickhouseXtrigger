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
import { WatcherCreator } from "../WatcherEditor/WatcherCreator";
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
 * The New-watcher button's handle on the same panel. A create and an edit share
 * one panel (see below), so the trigger reaches it the same way the Edit buttons
 * do — through context — rather than owning a second panel of its own.
 */
const WatchCreatorContext = createContext<(() => void) | null>(null);

/**
 * The Edit button's handle on the panel. Null outside a WatchWorkspace, so a
 * control rendered there simply has nothing to open rather than throwing.
 */
export function useWatchEditor(): ((watcher: WatcherEdit) => void) | null {
  return useContext(WatchEditorContext);
}

/**
 * The New-watcher button's handle on the panel — open it in create mode. Null
 * outside a WatchWorkspace, same as useWatchEditor.
 */
export function useWatchCreator(): (() => void) | null {
  return useContext(WatchCreatorContext);
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
  // Which panel the one list-level push panel is showing: a create, an edit of a
  // specific watcher, or nothing. One value so create and edit share the single
  // panel and can never both be open — opening New replaces any edit, opening
  // Edit replaces a create, exactly like the board's tile panel.
  const [panel, setPanel] = useState<
    { mode: "create" } | { mode: "edit"; watcher: WatcherEdit } | null
  >(null);
  const openEdit = useCallback(
    (watcher: WatcherEdit) => setPanel({ mode: "edit", watcher }),
    [],
  );
  const openCreate = useCallback(() => setPanel({ mode: "create" }), []);
  const close = useCallback(() => setPanel(null), []);
  const editing = panel?.mode === "edit" ? panel.watcher : null;

  useEffect(() => {
    if (panel === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, close]);

  return (
    <WatchEditorContext.Provider value={openEdit}>
      <WatchCreatorContext.Provider value={openCreate}>
        <PushLayout>
          {children}

          {/* One panel for the whole list: a create OR an edit of one watcher,
              never both (they share `panel`). The studio toolbar carries the
              close (showClose={false}), so the panel draws none of its own. Empty
              when nothing is open, so it collapses to width:0 and the list returns
              to full width. The editor is keyed on the watcher id, so opening a
              different one — or switching from create to edit — is a remount that
              re-seeds the studio with no reset wiring. */}
          <PushPanel
            open={panel !== null}
            onClose={close}
            label={panel?.mode === "create" ? "Create watcher" : "Edit watcher"}
            showClose={false}
          >
            {panel?.mode === "create" ? (
              <WatcherCreator actions={actions} onClose={close} />
            ) : editing ? (
              <WatcherEditor
                key={editing.id}
                watcher={editing}
                actions={actions}
                onClose={close}
              />
            ) : null}
          </PushPanel>
        </PushLayout>
      </WatchCreatorContext.Provider>
    </WatchEditorContext.Provider>
  );
}

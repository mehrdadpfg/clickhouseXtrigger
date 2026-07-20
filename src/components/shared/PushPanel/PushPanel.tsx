"use client";

import type { ReactNode } from "react";
import styles from "./PushPanel.module.css";

/**
 * The push-panel shell, host-agnostic: a floating surface that opens beside a
 * host's main content by taking width rather than covering it.
 *
 * Extracted from the chat's chart workspace so a board (editing a tile) and the
 * watch list (editing a watcher) get the same move the thread already had. It is
 * PURE LAYOUT: it imports no chat, board or watch code and knows nothing of
 * ChartStudio, charts, tiles or watchers — a host lays out {@link PushLayout} as
 * a flex row of [main content] + [{@link PushPanel}], and whatever fills the
 * surface is the host's business.
 */

type PushLayoutProps = {
  children: ReactNode;
  /** Extra classes on the flex row, e.g. to override --canvas-w. */
  className?: string;
  style?: React.CSSProperties;
};

/**
 * The flex row that holds the host's main content beside the panel. Main content
 * is flex:1 and shrinks as the panel opens; the panel is flex:0 0 auto and grows
 * from width:0. A host that wants a non-default canvas width overrides
 * `--canvas-w` via `style` or `className` on this element.
 */
export function PushLayout({ children, className, style }: PushLayoutProps) {
  return (
    <div
      className={className ? `${styles.workspace} ${className}` : styles.workspace}
      style={style}
    >
      {children}
    </div>
  );
}

type PushPanelProps = {
  /** Open slides the panel to --canvas-w; closed collapses it to width:0. */
  open: boolean;
  onClose: () => void;
  /** Names the region for assistive tech and the built-in close button. */
  label: string;
  children: ReactNode;
  /**
   * The panel renders its own close in the surface's top-right corner by
   * default. A host whose content carries its own close (a ChartStudio toolbar,
   * say) sets this false and wires onClose to that button instead — so the
   * panel never draws two.
   */
  showClose?: boolean;
};

/**
 * The width-animating panel: aside.panel(.panelOpen when open) > inner > surface
 * > children. The surface is a flex column, so the host's content fills it top to
 * bottom. `aria-hidden` when closed keeps the collapsed panel out of the tab
 * order and the accessibility tree — closing the panel returns focus order to
 * the main content on its own.
 *
 * Esc-to-close and focus management are the HOST's to wire: they depend on what
 * the host considers "open" and where focus should land, which a pure layout
 * shell can't know. (The chat, for one, closes on Esc from anywhere but lets a
 * half-written composer swallow Esc first.)
 */
export function PushPanel({
  open,
  onClose,
  label,
  children,
  showClose = true,
}: PushPanelProps) {
  return (
    <aside
      className={open ? `${styles.panel} ${styles.panelOpen}` : styles.panel}
      aria-hidden={!open}
      aria-label={label}
    >
      <div className={styles.inner}>
        <div className={styles.surface}>
          {children}
          {showClose ? (
            <button
              type="button"
              className={`${styles.close} ${styles.closeFloat}`}
              onClick={onClose}
              aria-label={`Close ${label}`}
            >
              <span aria-hidden="true">✕</span>
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

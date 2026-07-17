"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import styles from "./Modal.module.css";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Names the dialog for assistive tech via aria-labelledby. */
  title: string;
  icon?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** The action bar. Rendered only when provided. */
  footer?: ReactNode;
  /** Focused on open. Defaults to the first focusable node in the dialog. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  icon,
  size = "md",
  footer,
  initialFocusRef,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropPointerDown = useRef(false);
  const titleId = useId();

  // createPortal needs a real document, which does not exist during SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Move focus in on open, and put it back where it came from on close —
  // otherwise a keyboard user is dumped at the top of the document.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const node = dialogRef.current;
    const target =
      initialFocusRef?.current ??
      node?.querySelector<HTMLElement>(FOCUSABLE) ??
      node;
    target?.focus();

    return () => previouslyFocused?.focus?.();
  }, [open, initialFocusRef]);

  // The page behind a modal must not scroll under it.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // ESC to close, and a Tab cycle that cannot leave the dialog.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const node = dialogRef.current;
      if (!node) return;

      const items = Array.from(
        node.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

      // Nothing focusable inside: keep focus on the dialog rather than
      // letting Tab escape to the page behind the scrim.
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className={styles.backdrop}
      // Close only when the press *starts and ends* on the backdrop. A plain
      // onClick would also fire when a text selection began inside the dialog
      // and released outside it, closing the modal mid-drag.
      onMouseDown={(e) => {
        backdropPointerDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropPointerDown.current) {
          onClose();
        }
        backdropPointerDown.current = false;
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${styles.dialog} ${styles[size]}`}
      >
        <div className={styles.header}>
          {icon ? (
            <span className={styles.icon} aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close dialog"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className={styles.body}>{children}</div>

        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

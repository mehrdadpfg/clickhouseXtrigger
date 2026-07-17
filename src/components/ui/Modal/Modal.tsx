"use client";

import type { ReactNode, RefObject } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "../shadcn/dialog";
import { cn } from "@/lib/utils";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Names the dialog for assistive tech via the title. */
  title: string;
  icon?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** The action bar. Rendered only when provided. */
  footer?: ReactNode;
  /** Focused on open. Defaults to Radix's own first-focusable behaviour. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}

const SIZE_CLASS: Record<NonNullable<ModalProps["size"]>, string> = {
  sm: "sm:max-w-[460px]",
  md: "sm:max-w-[480px]",
  lg: "sm:max-w-[640px]",
};

/**
 * Radix dialog under the hood: focus trap, ESC, backdrop click and body-scroll
 * lock come from the primitive. Depth (var(--shadow-overlay)) is kept — a modal
 * is one of the few surfaces allowed to cast a shadow in Onyx.
 */
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
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          if (initialFocusRef?.current) {
            event.preventDefault();
            initialFocusRef.current.focus();
          }
        }}
        className={cn(
          "flex max-h-[calc(100%-3rem)] flex-col gap-0 overflow-hidden rounded-[var(--r-lg)] border-[var(--border-strong)] bg-card p-0 text-[var(--text)] shadow-[var(--shadow-overlay)]",
          SIZE_CLASS[size],
        )}
      >
        <div className="flex flex-shrink-0 items-center gap-[9px] border-b border-border px-5 py-4">
          {icon ? (
            <span className="text-[15px] leading-none text-brand" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <DialogTitle className="text-[15px] font-semibold">
            {title}
          </DialogTitle>
          <DialogClose
            aria-label="Close dialog"
            className="ml-auto rounded-[var(--r-sm)] p-1 text-[16px] leading-none text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
          >
            <span aria-hidden="true">✕</span>
          </DialogClose>
        </div>

        <div className="overflow-y-auto px-5 py-[18px]">{children}</div>

        {footer ? (
          <div className="flex flex-shrink-0 items-center gap-[9px] border-t border-border px-5 py-[14px]">
            {footer}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

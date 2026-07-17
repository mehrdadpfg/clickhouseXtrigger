"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { BoardActions } from "../model";
import styles from "../BoardForms.module.css";

/**
 * The Boards header's only client state: is the create-board modal open.
 *
 * The modal lives here so the boards list can stay a server component — every
 * other string it renders was already formatted server-side. Creating a board
 * navigates straight into it, so the first thing the analyst does is add a tile.
 */
export function NewBoardButton({
  actions,
  variant = "primary",
}: {
  actions: BoardActions;
  /** The empty state offers the same action as a larger, centred button. */
  variant?: "primary" | "ghost";
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant={variant}
        size="sm"
        icon="＋"
        onClick={() => setOpen(true)}
      >
        New board
      </Button>
      <NewBoardModal
        open={open}
        onClose={() => setOpen(false)}
        actions={actions}
      />
    </>
  );
}

function NewBoardModal({
  open,
  onClose,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  actions: BoardActions;
}) {
  const router = useRouter();
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Stays mounted while `open` flips, so last time's draft would linger.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setError(null);
  }, [open]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError("Name the board.");

    setError(null);
    startTransition(async () => {
      const result = await actions.createBoard(name);
      if (result.ok) {
        onClose();
        router.push(`/boards/${result.data.id}`);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New board"
      icon="▦"
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={pending}
            className={styles.submit}
          >
            {pending ? "Creating…" : "Create board"}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          <span className={styles.eyebrow}>Name</span>
          <input
            ref={inputRef}
            className={styles.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Airport operations"
            autoComplete="off"
            required
          />
        </label>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

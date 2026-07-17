"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Modal } from "@/components/ui";
import type { ChartSpec } from "@/components/ui";
import {
  listBoardsForPickerAction,
  pinChartToBoardAction,
} from "@/app/boards/actions";
import styles from "./AgentTurn.module.css";

/**
 * Pin a chat answer's chart onto a board. Lists existing boards to drop it on,
 * or names a new one. The chart's query + flint spec ride along so the board
 * renders the same chart, live.
 */
export function BoardPickerModal({
  open,
  onClose,
  title,
  sql,
  spec,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sql: string;
  spec: Pick<ChartSpec, "chartType" | "encodings"> &
    Partial<Pick<ChartSpec, "horizontal" | "semanticTypes">>;
}) {
  const [boards, setBoards] = useState<{ id: string; title: string }[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNewTitle("");
    void listBoardsForPickerAction().then(setBoards);
  }, [open]);

  function pin(target: { kind: "existing"; boardId: string } | { kind: "new"; title: string }) {
    setError(null);
    startTransition(async () => {
      const result = await pinChartToBoardAction({ target, title, sql, spec });
      if (result.ok) onClose();
      else setError(result.error);
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Add chart to dashboard">
      <div className={styles.picker}>
        {boards.length > 0 ? (
          <>
            <div className={styles.pickerLabel}>Add to an existing board</div>
            <div className={styles.pickerBoards}>
              {boards.map((b) => (
                <Button
                  key={b.id}
                  size="sm"
                  disabled={pending}
                  onClick={() => pin({ kind: "existing", boardId: b.id })}
                >
                  {b.title}
                </Button>
              ))}
            </div>
          </>
        ) : null}

        <div className={styles.pickerLabel}>Or create a new board</div>
        <form
          className={styles.pickerNew}
          onSubmit={(e) => {
            e.preventDefault();
            const name = newTitle.trim();
            if (name) pin({ kind: "new", title: name });
          }}
        >
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="New board name…"
            aria-label="New board name"
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={pending || newTitle.trim() === ""}
          >
            Create &amp; add
          </Button>
        </form>

        {error ? <p className={styles.pickerError}>{error}</p> : null}
      </div>
    </Modal>
  );
}

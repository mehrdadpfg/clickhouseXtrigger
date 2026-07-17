"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Modal } from "@/components/ui";
import type { ChartSpec } from "@/components/ui";
import {
  listBoardsForPickerAction,
  pinChartsToBoardAction,
  pinStatsToBoardAction,
} from "@/app/boards/actions";
import styles from "./AgentTurn.module.css";

/** One chart the turn drew, with the query that fed it — enough to pin a tile. */
export interface PinnableChart {
  title: string;
  sql: string;
  spec: Pick<ChartSpec, "chartType" | "encodings"> &
    Partial<Pick<ChartSpec, "horizontal" | "semanticTypes">>;
}

/**
 * One headline number the turn showed, with the query that produced it — enough
 * to pin a KPI tile. `label` is the metric's name; `unit` is a display hint.
 */
export interface PinnableStat {
  label: string;
  sql: string;
  unit?: string;
}

/**
 * Pin a chat answer's chart(s) onto a board. Lists existing boards to drop them
 * on, or names a new one. Each chart's query + flint spec ride along so the
 * board renders the same charts, live. A dashboard-style answer (several charts)
 * lands as several tiles on one board in a single click.
 */
export function BoardPickerModal({
  open,
  onClose,
  charts,
  stats = [],
}: {
  open: boolean;
  onClose: () => void;
  charts: PinnableChart[];
  stats?: PinnableStat[];
}) {
  const [boards, setBoards] = useState<{ id: string; title: string }[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const count = charts.length + stats.length;
  const many = count > 1;
  // Title reads for whatever the answer produced: charts, stats, or a mix.
  const noun =
    charts.length > 0 && stats.length > 0
      ? "tiles"
      : stats.length > 0
        ? count === 1
          ? "stat"
          : "stats"
        : count === 1
          ? "chart"
          : "charts";

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNewTitle("");
    void listBoardsForPickerAction().then(setBoards);
  }, [open]);

  function pin(target: { kind: "existing"; boardId: string } | { kind: "new"; title: string }) {
    setError(null);
    startTransition(async () => {
      // Charts-only keeps the original path untouched. Anything involving stats
      // goes through pinStatsToBoardAction, which mints/confirms ONE board and
      // adds both kinds — so a mixed answer never splits across two new boards.
      const result =
        stats.length === 0
          ? await pinChartsToBoardAction({ target, charts })
          : await pinStatsToBoardAction({
              target,
              stats,
              ...(charts.length > 0 ? { charts } : {}),
            });
      if (result.ok) onClose();
      else setError(result.error);
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={many ? `Add ${count} ${noun} to dashboard` : `Add ${noun} to dashboard`}
    >
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

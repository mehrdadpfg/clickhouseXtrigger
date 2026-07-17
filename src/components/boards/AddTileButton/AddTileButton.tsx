"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SegmentedControl } from "@/components/ui";
import {
  TILE_KINDS,
  TILE_UNITS,
  type BoardActions,
} from "../model";
import type { BoardTileKind } from "@/types/db";
import styles from "../BoardForms.module.css";

/**
 * Adds a tile to *this* board. The board is bound (the detail route knows which
 * one), so the modal only collects what a tile is: a kind, a title, the SQL it
 * re-runs live, and — for a KPI or chart — how to format the number.
 *
 * The SQL is stored, then run by id server-side; it is never executed straight
 * from this island. What the analyst types here is a tile definition, not a
 * query this component runs.
 */
export function AddTileButton({
  boardId,
  actions,
}: {
  boardId: string;
  actions: BoardActions;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="ghost" size="sm" icon="＋" onClick={() => setOpen(true)}>
        Add tile
      </Button>
      <AddTileModal
        boardId={boardId}
        open={open}
        onClose={() => setOpen(false)}
        actions={actions}
      />
    </>
  );
}

function AddTileModal({
  boardId,
  open,
  onClose,
  actions,
}: {
  boardId: string;
  open: boolean;
  onClose: () => void;
  actions: BoardActions;
}) {
  const router = useRouter();
  const formId = useId();
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState<BoardTileKind>("kpi");
  const [title, setTitle] = useState("");
  const [unit, setUnit] = useState("");
  const [sql, setSql] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setKind("kpi");
    setTitle("");
    setUnit("");
    setSql("");
    setError(null);
  }, [open]);

  // A table renders every column as-is; there is no single number to format, so
  // the unit picker only applies to a KPI or a chart.
  const showUnit = kind !== "table";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const finalTitle = title.trim();
    const finalSql = sql.trim();
    if (!finalTitle) return setError("Give the tile a title.");
    if (!finalSql) return setError("The tile needs a query.");

    setError(null);
    startTransition(async () => {
      const result = await actions.addTile({
        target: { kind: "existing", boardId },
        kind,
        title: finalTitle,
        sql: finalSql,
        ...(showUnit && unit ? { unit } : {}),
      });
      if (result.ok) {
        onClose();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add tile"
      icon="▦"
      initialFocusRef={firstFieldRef}
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
            {pending ? "Adding…" : "Add tile"}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={submit}>
        <div className={styles.field}>
          <span className={styles.eyebrow}>Kind</span>
          <SegmentedControl<BoardTileKind>
            aria-label="Kind"
            options={[...TILE_KINDS]}
            value={kind}
            onChange={setKind}
          />
        </div>

        <label className={styles.field}>
          <span className={styles.eyebrow}>Title</span>
          <input
            ref={firstFieldRef}
            className={styles.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Avg card tip · 30d"
            autoComplete="off"
            required
          />
        </label>

        {showUnit ? (
          <div className={styles.field}>
            <span className={styles.eyebrow}>Unit</span>
            <SegmentedControl
              aria-label="Unit"
              options={[...TILE_UNITS]}
              value={unit}
              onChange={setUnit}
            />
          </div>
        ) : null}

        <label className={styles.field}>
          <span className={styles.eyebrow}>SQL</span>
          <span className={styles.fieldHint}>
            Re-run live each time the board opens.
          </span>
          <textarea
            className={`${styles.input} ${styles.sql}`}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            placeholder="select … from db.table …"
            rows={4}
            spellCheck={false}
            required
          />
        </label>

        <p className={styles.summary}>
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>{" "}
          A <strong>{kind}</strong> tile, run live from its stored query. Reads
          only — the query runs under ClickHouse read-only guards.
        </p>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

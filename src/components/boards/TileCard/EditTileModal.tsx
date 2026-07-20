"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SegmentedControl } from "@/components/ui";
import { loadTileDraftAction } from "@/app/boards/actions";
import {
  TILE_KINDS,
  TILE_UNITS,
  TILE_WIDTHS,
  clampSpan,
  type BoardActions,
  type TileView,
} from "../model";
import type { BoardTileKind } from "@/types/db";
import styles from "../BoardForms.module.css";

/**
 * Edit a tile in place: its kind, title, unit, width and the SQL it re-runs live.
 *
 * The SQL isn't in the tile shell (it's fetched by id and run server-side), so
 * the current values are loaded on open via loadTileDraftAction rather than read
 * off the client. Width is here as well as on the tile's ⤢ button: the button
 * only cycles 1→2→3→4→1, so reaching a narrower width means walking the whole
 * ring, and it gives no way to see the current width without changing it.
 * Saving goes through the bound `updateTile` action.
 */
export function EditTileModal({
  tile,
  actions,
  open,
  onClose,
  onSaved,
}: {
  tile: TileView;
  actions: BoardActions;
  open: boolean;
  onClose: () => void;
  /**
   * Ask the board to re-run its tiles.
   *
   * This is not optional politeness — it is the only thing that makes an SQL
   * edit visible. `router.refresh()` re-renders the tile *shells* from the
   * server, but a tile's rows are not in that render: the board fetches them
   * separately and keys that fetch on the tile ids, which an edit does not
   * change. Drop this call and saving new SQL leaves the old numbers on screen,
   * with no spinner and nothing to suggest they are stale.
   */
  onSaved?: () => void;
}) {
  const router = useRouter();
  const formId = useId();
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState<BoardTileKind>(tile.kind);
  const [title, setTitle] = useState(tile.title);
  const [unit, setUnit] = useState("");
  const [span, setSpan] = useState(tile.span);
  const [sql, setSql] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    setLoading(true);
    void loadTileDraftAction(tile.id).then((draft) => {
      if (!live) return;
      if (draft) {
        setKind(draft.kind);
        setTitle(draft.title);
        setUnit(draft.unit);
        setSpan(clampSpan(draft.span));
        setSql(draft.sql);
      }
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [open, tile.id]);

  const showUnit = kind !== "table";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const finalTitle = title.trim();
    const finalSql = sql.trim();
    if (!finalTitle) return setError("Give the tile a title.");
    if (!finalSql) return setError("The tile needs a query.");

    setError(null);
    startTransition(async () => {
      const result = await actions.updateTile({
        tileId: tile.id,
        title: finalTitle,
        kind,
        sql: finalSql,
        unit: showUnit ? unit : "",
        span: clampSpan(span),
      });
      if (result.ok) {
        onClose();
        onSaved?.();
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
      title="Edit tile"
      icon="✎"
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
            disabled={pending || loading}
            className={styles.submit}
          >
            {pending ? "Saving…" : "Save changes"}
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

        <div className={styles.field}>
          <span className={styles.eyebrow}>Width</span>
          <SegmentedControl
            aria-label="Width"
            options={[...TILE_WIDTHS]}
            value={String(span)}
            onChange={(next) => setSpan(clampSpan(Number(next)))}
          />
        </div>

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

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

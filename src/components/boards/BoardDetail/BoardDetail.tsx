"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AddTileButton } from "../AddTileButton/AddTileButton";
import { TileCard } from "../TileCard/TileCard";
import { GRID_COLUMNS, type BoardActions, type BoardView, type TileView } from "../model";
import styles from "./BoardDetail.module.css";

/**
 * One opened board.
 *
 * A client island: the tile *definitions* still come from the server (each
 * TileCard runs its own SQL by id), but the board owns the tile ORDER so a drag
 * can reorder them live and persist through the reorder action. Local order is
 * optimistic — it re-syncs whenever the server sends a different set/sequence.
 */
export function BoardDetail({
  board,
  actions,
}: {
  board: BoardView;
  actions: BoardActions;
}) {
  const router = useRouter();
  const [order, setOrder] = useState<TileView[]>(board.tiles);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [, startSave] = useTransition();

  // Re-sync to the server whenever the tiles it sends differ from what we hold
  // (added/removed, reordered, or EDITED). Keyed on content, not just the id
  // sequence: `order` holds whole TileViews, so it is the state the grid renders
  // from — an id-only key can't tell that a refresh brought back a new span or
  // title, the effect never fires, and the stale copy in `order` silently wins.
  // That's what made the ⤢ resize snap back; it only ever appeared to work
  // because the `actions` prop identity churns and re-runs each tile's query.
  // Still keyed on a value rather than `board.tiles` itself, so an identical
  // refresh doesn't clobber an in-flight optimistic order.
  const serverKey = board.tiles
    .map((t) => `${t.id}:${t.span}:${t.kind}:${t.title}:${JSON.stringify(t.spec)}`)
    .join("|");
  useEffect(() => {
    setOrder(board.tiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  // Latest order for the drag-end commit, so its closure isn't stale.
  const orderRef = useRef(order);
  orderRef.current = order;
  // Deliberately the id sequence and nothing more: this one answers "did the
  // drag actually move anything?", which a content change must not affect.
  const orderKey = board.tiles.map((t) => t.id).join(",");
  const committedKey = useRef(orderKey);

  const move = (draggedId: string, overId: string) => {
    if (draggedId === overId) return;
    setOrder((prev) => {
      const from = prev.findIndex((t) => t.id === draggedId);
      const to = prev.findIndex((t) => t.id === overId);
      if (from === -1 || to === -1 || from === to) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  };

  const commit = () => {
    const orderedIds = orderRef.current.map((t) => t.id);
    const key = orderedIds.join(",");
    setDraggingId(null);
    // Nothing moved — don't write.
    if (key === committedKey.current) return;
    committedKey.current = key;
    startSave(async () => {
      const result = await actions.reorder({ boardId: board.id, orderedIds });
      if (result.ok) router.refresh();
      else {
        // Roll back to the server's truth on failure.
        setOrder(board.tiles);
        committedKey.current = orderKey;
      }
    });
  };

  const count = order.length;

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headInner}>
          <Link href="/boards" className={styles.back}>
            ← Boards
          </Link>
          <h1 className={styles.title}>{board.title}</h1>
          <div className={styles.actions}>
            <AddTileButton boardId={board.id} actions={actions} />
          </div>
        </div>
      </header>

      <div className={styles.body}>
        {count === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyMark} aria-hidden="true">
              ▦
            </span>
            <h2 className={styles.emptyTitle}>No tiles yet</h2>
            <p className={styles.emptyCopy}>
              A tile stores the query that produces it, so the board re-runs live
              rather than caching a snapshot. Add one to get started.
            </p>
            <AddTileButton boardId={board.id} actions={actions} />
          </div>
        ) : (
          <div
            className={styles.grid}
            style={{
              gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
            }}
          >
            {order.map((tile) => (
              <TileCard
                key={tile.id}
                tile={tile}
                actions={actions}
                dnd={{
                  dragging: draggingId === tile.id,
                  onGripDragStart: (e) => {
                    setDraggingId(tile.id);
                    e.dataTransfer.effectAllowed = "move";
                    // Firefox needs data set for a drag to begin.
                    e.dataTransfer.setData("text/plain", tile.id);
                  },
                  onGripDragEnd: commit,
                  onDragOver: (e) => {
                    if (!draggingId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    move(draggingId, tile.id);
                  },
                  onDrop: (e) => e.preventDefault(),
                }}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

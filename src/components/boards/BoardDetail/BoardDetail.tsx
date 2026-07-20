"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AddTileButton } from "../AddTileButton/AddTileButton";
import { TileCard, type TileLoad } from "../TileCard/TileCard";
import { GRID_COLUMNS, type BoardActions, type BoardView, type TileView } from "../model";
import styles from "./BoardDetail.module.css";

/**
 * One opened board.
 *
 * A client island that owns two things the tiles cannot own individually:
 *
 * ORDER, so a drag can reorder live and persist through the reorder action.
 * Local order is optimistic — it re-syncs whenever the server sends a different
 * set/sequence.
 *
 * RESULTS. Each tile used to run its own SQL on mount, which read as N
 * independent loads but was not: Next serialises server-action POSTs from one
 * client, so a 10-tile board was a 4.8s chain of ~200ms queries, never more than
 * one in flight (measured). A client-side concurrency limiter cannot help — the
 * queue is in the transport, not here. So the board asks once, through runBoard,
 * and hands each tile its rows.
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

  // --- results -------------------------------------------------------------

  const [loads, setLoads] = useState<Record<string, TileLoad>>({});

  /**
   * How many queries are in flight *per tile*, not whether one is.
   *
   * A board load and a single-tile ⟳ can overlap, and with a boolean the one
   * that finishes first re-enables the other's ⟳ while its query is still
   * running. Counting means each starter releases only what it took.
   */
  const [busy, setBusy] = useState<Record<string, number>>({});
  const acquire = useCallback((ids: string[]) => {
    setBusy((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = (next[id] ?? 0) + 1;
      return next;
    });
  }, []);
  const release = useCallback((ids: string[]) => {
    setBusy((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        const n = (next[id] ?? 1) - 1;
        if (n > 0) next[id] = n;
        else delete next[id];
      }
      return next;
    });
  }, []);

  /**
   * Bumped by anything that changes a tile's SQL without changing the id list.
   *
   * This is the load-bearing half of moving the load up here, and it replaces a
   * side effect nobody had written down. A tile used to re-run after an SQL edit
   * only because its effect was keyed on `[actions, tile.id]` and the `actions`
   * prop is a fresh object on every server render — so `router.refresh()` in the
   * edit modal churned that identity and the query re-ran by accident. The board
   * load below is deliberately NOT keyed on `actions` (that would re-run every
   * tile on every unrelated refresh), which means the accident is gone and the
   * refresh has to be asked for explicitly. Without this counter the board would
   * get four times faster and quietly serve the pre-edit rows.
   */
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // Server actions are fresh objects each render; reading them through a ref
  // keeps that churn out of the effect's dependencies. See `version` above.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  /**
   * When to re-run the board: the id SET changed (added/removed/opened a
   * different board) or something asked for it. Deliberately NOT the content key
   * used for the order re-sync — a title, width or spec edit changes what a tile
   * *looks* like, not what its SQL returns, and re-running ten queries because
   * one tile got wider is the waste this whole step exists to remove.
   *
   * Reorder is excluded for exactly that reason, which is why this sorts and
   * `orderKey` below deliberately does not. A drag changes no tile's SQL, so it
   * must not change this key: unsorted, one drag cost the full ten queries
   * (~1.3s) on top of the reorder write and the router refresh. `orderKey`
   * answers a different question — "did the drag actually move anything?" — and
   * that one is about sequence, so the two keys must not be shared.
   *
   * An add trips both halves (reload() now, the id list a moment later when the
   * router refresh lands) and so loads twice. That is deliberate rather than
   * tolerated: the first load already sees the new tile server-side, so its rows
   * are waiting by the time the refresh renders it, and the board never has to
   * depend on the router being prompt to show fresh data.
   */
  const loadKey = `${board.id}|${[...board.tiles]
    .map((t) => t.id)
    .sort()
    .join(",")}|${version}`;

  // Only the newest load may write. Without this a slow load started before an
  // edit can land after the load started by it, restoring the stale rows.
  const loadSeq = useRef(0);

  useEffect(() => {
    const seq = ++loadSeq.current;
    const ids = board.tiles.map((t) => t.id);
    acquire(ids);

    void actionsRef.current
      .runBoard(board.id)
      .then((result) => {
        if (seq !== loadSeq.current) return;
        setLoads((prev) => {
          // Rebuilt from the ids in play rather than spread from `prev`, so a
          // removed tile's entry goes with it instead of accumulating for the
          // life of the mount.
          const next: Record<string, TileLoad> = {};
          for (const id of ids) {
            if (!result.ok) {
              next[id] = { status: "error", error: result.error };
              continue;
            }
            const tile = result.tiles[id];
            next[id] = tile
              ? tile.ok
                ? { status: "ready", rows: tile.rows }
                : { status: "error", error: tile.error }
              : { status: "error", error: "That tile no longer exists." };
          }
          // Tiles the server returned that we haven't been told to render yet —
          // a just-added tile — so its rows are there the moment it appears.
          if (result.ok) {
            for (const [id, tile] of Object.entries(result.tiles)) {
              if (next[id]) continue;
              // Keep whatever we already held for it; a failed query on a tile
              // that isn't on screen has nowhere to report itself.
              const held = prev[id];
              if (tile.ok) next[id] = { status: "ready", rows: tile.rows };
              else if (held) next[id] = held;
            }
          }
          return next;
        });
      })
      // The POST itself can reject — a dev-server restart, a dropped
      // connection — and that path writes nothing, so without this every tile
      // stays "loading" with its ⟳ disabled by `busy` and the board has no way
      // back. One failed request used to strand one tile; it now strands ten.
      .catch((cause: unknown) => {
        if (seq !== loadSeq.current) return;
        const error = cause instanceof Error ? cause.message : "The board could not be reached.";
        setLoads((prev) => {
          const next: Record<string, TileLoad> = {};
          for (const id of ids) next[id] = prev[id] ?? { status: "error", error };
          return next;
        });
      })
      // Released even when superseded: this load's counts are its own, and the
      // load that replaced it is still holding its own.
      .finally(() => release(ids));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  /** The ⟳ on a single tile. One tile, one query — no reason to run the board. */
  const refreshTile = useCallback(
    (tileId: string) => {
      acquire([tileId]);
      void actions
        .run(tileId)
        .then((result) => {
          setLoads((prev) => ({
            ...prev,
            [tileId]: result.ok
              ? { status: "ready", rows: result.rows }
              : { status: "error", error: result.error },
          }));
        })
        .catch((cause: unknown) => {
          setLoads((prev) => ({
            ...prev,
            [tileId]: prev[tileId] ?? {
              status: "error",
              error: cause instanceof Error ? cause.message : "That tile could not be reached.",
            },
          }));
        })
        .finally(() => release([tileId]));
    },
    [actions, acquire, release],
  );

  // Latest order for the drag-end commit, so its closure isn't stale.
  const orderRef = useRef(order);
  orderRef.current = order;
  // Deliberately the id sequence and nothing more: this one answers "did the
  // drag actually move anything?", which a content change must not affect —
  // and, unlike `loadKey` above, it must stay unsorted for that to work.
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
            <AddTileButton boardId={board.id} actions={actions} onAdded={reload} />
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
            <AddTileButton boardId={board.id} actions={actions} onAdded={reload} />
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
                load={loads[tile.id] ?? { status: "loading" }}
                busy={(busy[tile.id] ?? 0) > 0}
                onRefresh={() => refreshTile(tile.id)}
                onEdited={reload}
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

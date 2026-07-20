"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AddTileButton } from "../AddTileButton/AddTileButton";
import { TileCard, type TileLoad } from "../TileCard/TileCard";
import { GRID_COLUMNS, type BoardActions, type BoardView, type TileView } from "../model";
import { RefreshControl } from "./RefreshControl";
import { intervalMsOf, useRefreshInterval } from "./refreshInterval";
import styles from "./BoardDetail.module.css";

/**
 * How long a board run may be outstanding before it is presumed lost.
 *
 * READONLY_SETTINGS caps a query at max_execution_time: 30 (lib/clickhouse/
 * client.ts), so a run still unsettled well past that is not slow — its promise
 * will never settle at all, and the in-flight guard has to be able to step over
 * it or one dropped request disables refresh for the rest of the session.
 */
const STUCK_AFTER_MS = 45_000;

/**
 * A failed run, shown against whatever the tile already had.
 *
 * Rows from two minutes ago are worth incomparably more than a red box where a
 * number used to be, and on a board that polls this is the difference between
 * one blip and a screen that empties itself on a blocked network. So a failure
 * only blanks a tile that had nothing to lose.
 */
function degrade(held: TileLoad | undefined, error: string): TileLoad {
  return held?.status === "ready"
    ? { status: "ready", rows: held.rows, staleError: error }
    : { status: "error", error };
}

/**
 * One opened board.
 *
 * A client island that owns three things the tiles cannot own individually:
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
 *
 * CADENCE, so the board can re-run itself. That is the same single call on a
 * timer, and it belongs here for the same reason the results do: ten tiles each
 * holding their own timer would be ten chains of serialised POSTs drifting out
 * of phase with each other, and no way to say "nine of these are current".
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
  // That's what made a resize snap back; it only ever appeared to work
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

  // The current tile ids, read through a ref so `loadBoard` keeps one identity
  // for the life of the mount. The interval below closes over it exactly once;
  // anything that rebuilt the callback would leave the timer calling a version
  // of it that predates the last edit.
  const idsRef = useRef<string[]>([]);
  idsRef.current = board.tiles.map((t) => t.id);

  /**
   * When the in-flight load started, or null when none is.
   *
   * A ref, not state, and that is the whole reason auto-refresh can be trusted:
   * the interval callback is created once and would capture a `refreshing`
   * boolean from the render that armed it, see `false` forever, and stack a run
   * on top of every run already going. A ref is read at call time.
   *
   * It holds a timestamp rather than a flag so it can also be disbelieved.
   * READONLY_SETTINGS caps a query at max_execution_time: 30, so a board run
   * that has not settled in 45s is not slow, it is lost — the promise was
   * dropped somewhere that neither `.then` nor `.catch` will ever hear about,
   * and a plain boolean would latch the board off for the rest of the session
   * with the Refresh button disabled and no way back.
   */
  const runStartedAt = useRef<number | null>(null);

  /** When the last run settled, for the visibility catch-up below. */
  const lastRunAt = useRef(0);

  /**
   * The same fact as `runStartedAt`, for rendering only.
   *
   * Both exist because they answer to different clocks. The ref is the guard and
   * must be current at call time; this is what the header draws and so has to go
   * through a render. Deriving the header from `busy` instead would have been
   * one fewer piece of state and wrong: a single tile's ⟳ marks that tile busy,
   * which would disable the board's Refresh button while the guard it is meant
   * to reflect would happily let the run through.
   */
  const [boardRunning, setBoardRunning] = useState(false);

  /**
   * Run every tile, in one call.
   *
   * `force` is for the load key changing — a different board, a tile added, an
   * edit asking for its rows. Those must supersede whatever is running rather
   * than be dropped by the in-flight guard, and `loadSeq` already guarantees
   * only the newest reply is allowed to write. The interval and the Refresh
   * button do not force: there, a run already going IS the refresh.
   */
  const loadBoard = useCallback(
    (options?: { force?: boolean }) => {
      const startedAt = runStartedAt.current;
      const inFlight =
        startedAt !== null && Date.now() - startedAt < STUCK_AFTER_MS;
      if (inFlight && !options?.force) return;

      const seq = ++loadSeq.current;
      const ids = idsRef.current;
      runStartedAt.current = Date.now();
      setBoardRunning(true);
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
                next[id] = degrade(prev[id], result.error);
                continue;
              }
              const tile = result.tiles[id];
              next[id] = tile
                ? tile.ok
                  ? { status: "ready", rows: tile.rows }
                  : degrade(prev[id], tile.error)
                : degrade(prev[id], "That tile no longer exists.");
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
          const error =
            cause instanceof Error ? cause.message : "The board could not be reached.";
          setLoads((prev) => {
            const next: Record<string, TileLoad> = {};
            for (const id of ids) next[id] = degrade(prev[id], error);
            return next;
          });
        })
        // Released even when superseded: this load's counts are its own, and the
        // load that replaced it is still holding its own. The clock is NOT: a
        // superseded run must not report itself as the current one finishing, or
        // a forced reload landing after it would leave the board marked idle
        // while its own query is still out.
        .finally(() => {
          release(ids);
          if (seq !== loadSeq.current) return;
          runStartedAt.current = null;
          lastRunAt.current = Date.now();
          setBoardRunning(false);
        });
    },
    [board.id, acquire, release],
  );

  useEffect(() => {
    loadBoard({ force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  // --- auto-refresh ----------------------------------------------------------

  // Named `refreshEvery`, not `interval`: the setter would otherwise shadow
  // window.setInterval inside the timer effect below.
  const [refreshEvery, setRefreshEvery] = useRefreshInterval(board.id);
  const intervalMs = intervalMsOf(refreshEvery);

  /**
   * The polling timer.
   *
   * Re-armed whenever the cadence changes and cleared on unmount, both by being
   * the effect's own subject rather than something kept alongside it.
   *
   * A hidden tab does not poll. A wallboard left open on a second monitor and
   * then buried behind a browser window is the case this is for: it would
   * otherwise run every tile's SQL every 30 seconds, indefinitely, for nobody.
   * The interval keeps ticking while hidden (a timer that fires and returns is
   * free; the queries are not) and the visibility handler owns the catch-up.
   *
   * That catch-up is why coming back is not simply "wait for the next tick": a
   * tab hidden for an hour on a 30s cadence would show hour-old numbers for a
   * further 30 seconds, with nothing on screen saying so — the tiles look
   * exactly like tiles that just refreshed. So if a full period has already
   * passed we run immediately and re-arm from now, rather than firing again a
   * few milliseconds later on the old phase.
   */
  useEffect(() => {
    if (intervalMs === null) return;

    let timer = 0;
    const arm = () => {
      window.clearInterval(timer);
      timer = window.setInterval(() => {
        if (document.visibilityState === "hidden") return;
        loadBoard();
      }, intervalMs);
    };
    arm();

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRunAt.current < intervalMs) return;
      loadBoard();
      arm();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, loadBoard]);

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
              : degrade(prev[tileId], result.error),
          }));
        })
        .catch((cause: unknown) => {
          setLoads((prev) => ({
            ...prev,
            [tileId]: degrade(
              prev[tileId],
              cause instanceof Error ? cause.message : "That tile could not be reached.",
            ),
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

  /**
   * How much of the board is not current.
   *
   * Counted off `loads` rather than tracked alongside it, so the header cannot
   * disagree with what the tiles are showing: a "lastRunFailed" tally kept on
   * the side would survive one tile's Retry succeeding and go on accusing a
   * board that is now fine.
   *
   * A tile counts whether it is blank (`error`) or holding old rows
   * (`staleError`) — both mean "this number is not from the last run", which is
   * the only distinction the header is making.
   */
  const failed = order.filter((tile) => {
    const load = loads[tile.id];
    return load?.status === "error" || (load?.status === "ready" && load.staleError);
  }).length;

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headInner}>
          <Link href="/boards" className={styles.back}>
            ← Boards
          </Link>
          <h1 className={styles.title}>{board.title}</h1>
          <div className={styles.actions}>
            {/* Only on a board that has tiles: on an empty one there is nothing
                to run and a cadence picker would offer to poll it anyway. */}
            {count > 0 ? (
              <RefreshControl
                interval={refreshEvery}
                onIntervalChange={setRefreshEvery}
                onRefresh={() => loadBoard()}
                refreshing={boardRunning}
                failed={failed}
                total={count}
              />
            ) : null}
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

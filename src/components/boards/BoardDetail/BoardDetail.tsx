import Link from "next/link";
import { Chip } from "@/components/ui";
import { AddTileButton } from "../AddTileButton/AddTileButton";
import { TileCard } from "../TileCard/TileCard";
import { GRID_COLUMNS, type BoardActions, type BoardView } from "../model";
import styles from "./BoardDetail.module.css";

/**
 * One opened board.
 *
 * A server component: the tile *shells* and layout are rendered here, and each
 * TileCard is the client island that runs its own SQL. The board's structure
 * is server data; only the live results cross the boundary, fetched by tile id.
 */
export function BoardDetail({
  board,
  actions,
}: {
  board: BoardView;
  actions: BoardActions;
}) {
  const count = board.tiles.length;

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headInner}>
          <Link href="/boards" className={styles.back}>
            ← Boards
          </Link>
          <h1 className={styles.title}>{board.title}</h1>
          <Chip
            className="tnum"
            label={`${count} ${count === 1 ? "tile" : "tiles"} · live`}
          />
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
            {board.tiles.map((tile) => (
              <TileCard key={tile.id} tile={tile} actions={actions} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

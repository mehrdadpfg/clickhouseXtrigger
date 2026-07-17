import Link from "next/link";
import { Chip } from "@/components/ui";
import { NewBoardButton } from "../NewBoardButton/NewBoardButton";
import type { BoardActions, BoardListItem } from "../model";
import styles from "./BoardsList.module.css";

/**
 * The boards index.
 *
 * A server component: every string here — titles, tile counts, the relative
 * timestamps — was formatted by the route at request time. The only client
 * island is the create-board button, which owns the modal.
 */
export function BoardsList({
  boards,
  actions,
  error,
}: {
  boards: BoardListItem[];
  actions: BoardActions;
  /** Postgres did not answer. A state to render, not a 500. */
  error?: string;
}) {
  return (
    <main className={styles.page}>
      <div className={styles.column}>
        <header className={styles.head}>
          <h1 className={styles.title}>Boards</h1>
          <p className={styles.lede}>
            A board pins the results you keep coming back to — each tile stores
            its query and re-runs live, never a cached snapshot.
          </p>
          <div className={styles.headMeta}>
            <Chip
              className="tnum"
              label={`${boards.length} ${boards.length === 1 ? "board" : "boards"}`}
            />
            <span className={styles.note}>pinned results · re-run live</span>
            {boards.length > 0 ? <NewBoardButton actions={actions} /> : null}
          </div>
        </header>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        {boards.length === 0 && !error ? (
          <div className={styles.empty}>
            <span className={styles.emptyMark} aria-hidden="true">
              ▦
            </span>
            <h2 className={styles.emptyTitle}>No boards yet</h2>
            <p className={styles.emptyCopy}>
              Create a board, then add tiles — a KPI, a chart, a table — each
              backed by its own query. Pin the questions you ask on repeat.
            </p>
            <NewBoardButton actions={actions} />
          </div>
        ) : (
          <ul className={styles.list}>
            {boards.map((board) => (
              <li key={board.id}>
                <Link href={`/boards/${board.id}`} className={styles.card}>
                  <span className={styles.cardIcon} aria-hidden="true">
                    ▦
                  </span>
                  <span className={styles.cardMain}>
                    <span className={styles.cardTitle}>{board.title}</span>
                    <span className={`tnum ${styles.cardMeta}`}>
                      {board.tileCount}{" "}
                      {board.tileCount === 1 ? "tile" : "tiles"} ·{" "}
                      <time dateTime={board.isoTime}>{board.timeLabel}</time>
                    </span>
                  </span>
                  <span className={styles.cardChevron} aria-hidden="true">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

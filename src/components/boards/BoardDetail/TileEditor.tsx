"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  asChartSpec,
  Button,
  inferChartSpec,
  Modal,
  SegmentedControl,
  type ChartSpec,
} from "@/components/ui";
import { Spinner } from "@/components/ui/Spinner";
import { ChartStudio, type StudioSlot } from "@/components/shared/ChartStudio";
import {
  getTileEditorMaxDateAction,
  getTileEditorSchemaAction,
  loadTileDraftAction,
  runTileDraftAction,
} from "@/app/boards/actions";
import {
  TILE_KINDS,
  TILE_UNITS,
  TILE_WIDTHS,
  clampSpan,
  type BoardActions,
  type ResultRow,
  type TileView,
} from "../model";
import type { BoardTileKind } from "@/types/db";
import styles from "../BoardForms.module.css";

/**
 * Edit a tile ON the ChartStudio — the same chart-plus-live-SQL surface the chat
 * and the watcher edit through — but hosted in the board's PUSH PANEL rather than
 * a modal. The board mounts exactly one of these, keyed on the edited tile's id,
 * inside a PushPanel that slides the grid aside; opening a different tile is a
 * remount, so the studio re-seeds without any reset wiring here.
 *
 * This is the former EditTileModal with its Modal shell removed: the panel is now
 * the surface, so this component renders only the studio and the board-specific
 * chrome around it — the tile's title/kind/unit/width, the Save that persists
 * them, and the Delete (with its confirmation) that used to sit on the tile
 * header. The delete CONFIRMATION stays a small Modal: it is a one-line "are you
 * sure", not an editing surface, and there is no trash to undo from.
 *
 * SEEDING. The studio draws from a ChartSpec, so one is assembled from the tile:
 * a pinned tile's stored flint spec, or an inferred one for a hand-made tile,
 * with the tile's *current rows* (handed down by the board, already on screen) as
 * its data and the loaded SQL attached so the editor opens on the real query. A
 * tile with nothing to draw (a bare KPI number, or a tile that is mid-error with
 * no rows) still opens: the spec falls back to empty channels, the studio shows a
 * table, and the author can fix the SQL and run it.
 *
 * The studio's own chart-type menu recasts the PREVIEW only and is not persisted
 * here — a tile's saved chart type is changed from the tile header's type menu,
 * which deliberately skips the board re-query (see TileCard). Save writes the
 * fields this host owns and asks the board to re-run so an edited query is
 * reflected; it does NOT force a board re-query on its own.
 */
export function TileEditor({
  tile,
  actions,
  onClose,
  onSaved,
  rows,
}: {
  tile: TileView;
  actions: BoardActions;
  /** Close the panel. Wired to the board's editor state. */
  onClose: () => void;
  /**
   * Ask the board to re-run its tiles after a save.
   *
   * Not optional politeness — it is the only thing that makes an SQL edit
   * visible. `router.refresh()` re-renders the tile *shells* from the server, but
   * a tile's rows are fetched separately and keyed on the tile ids, which an edit
   * does not change. Drop this and saving new SQL leaves the old numbers on
   * screen, with nothing to suggest they are stale.
   */
  onSaved?: () => void;
  /**
   * The rows the board is currently showing for this tile, if any. Seeds the
   * studio's chart so it opens on exactly what the tile displays, without a
   * second round trip; null when the tile is still loading or errored, in which
   * case the studio opens empty and the author's first Run fills it.
   */
  rows: ResultRow[] | null;
}) {
  const router = useRouter();

  const [kind, setKind] = useState<BoardTileKind>(tile.kind);
  const [title, setTitle] = useState(tile.title);
  const [unit, setUnit] = useState("");
  const [span, setSpan] = useState(tile.span);
  const [seedSql, setSeedSql] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startSave] = useTransition();
  const [removing, startRemove] = useTransition();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [schema, setSchema] = useState<
    Record<string, Record<string, string[]>> | undefined
  >();

  // Load the tile's editable fields on mount. The panel mounts this fresh per
  // tile (keyed on the id by the board), so there is no open/close guard: a new
  // tile is a new mount and loads its own draft. The SQL lives on the server
  // (fetched by id, never read off the client), so it arrives here rather than
  // being passed down as a prop.
  useEffect(() => {
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
        setSeedSql(draft.sql);
      }
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [tile.id]);

  // The autocomplete namespace: loaded once per mount, optional. The editor opens
  // fine without it, so a failure is swallowed by the action.
  useEffect(() => {
    let live = true;
    void getTileEditorSchemaAction().then((ns) => {
      if (live) setSchema(ns);
    });
    return () => {
      live = false;
    };
  }, []);

  const showUnit = kind !== "table";

  /**
   * The spec the studio draws from: the tile's stored flint spec (pinned tiles)
   * or one inferred from the rows (hand-made tiles), carrying the tile's current
   * rows as data and the loaded SQL so the editor opens on the real query. When
   * neither yields a spec — a single-number KPI, or a tile with no rows yet — a
   * minimal spec with empty channels stands in, which the studio renders as a
   * table rather than a broken chart.
   */
  const seedSpec = useMemo<ChartSpec | null>(() => {
    if (seedSql === null) return null;
    const data = rows ?? [];
    const stored = tile.spec.chartType
      ? asChartSpec({ ...tile.spec, title: tile.title, data })
      : null;
    const base = stored ?? inferChartSpec(data, tile.title);
    if (base) return { ...base, sql: seedSql };
    return {
      chartType: "Bar Chart",
      title: tile.title,
      encodings: {},
      data,
      sql: seedSql,
    };
  }, [seedSql, rows, tile.spec, tile.title]);

  const save = (draftSql: string) => {
    const finalTitle = title.trim();
    const finalSql = draftSql.trim();
    if (!finalTitle) return setError("Give the tile a title.");
    if (!finalSql) return setError("The tile needs a query.");

    setError(null);
    startSave(async () => {
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
  };

  /**
   * Delete, moved here from the tile header. Same confirmation it always had —
   * there is no trash to restore from, so the cheap guard is the honest one — and
   * a board refresh once it is gone so the tile leaves the grid.
   */
  const remove = () => {
    setConfirmingRemove(false);
    startRemove(async () => {
      const result = await actions.removeTile(tile.id);
      if (result.ok) {
        onClose();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const busy = pending || removing;

  return (
    <>
      {loading || !seedSpec ? (
        <div className={styles.studioLoading}>
          <Spinner label="loading…" />
        </div>
      ) : (
        <ChartStudio
          spec={seedSpec}
          onRun={(sql) => runTileDraftAction(sql)}
          {...(schema ? { schema } : {})}
          resolveMaxDate={getTileEditorMaxDateAction}
          actions={(slot: StudioSlot) => (
            // The panel draws no close of its own (showClose={false}); the studio
            // toolbar carries it, matching the chat's workspace.
            <button
              type="button"
              className={slot.buttonClass}
              onClick={onClose}
              aria-label="Close the tile editor"
            >
              <span aria-hidden="true">✕</span>
            </button>
          )}
          footer={(slot: StudioSlot) => (
            <div className={styles.studioFoot}>
              <div className={styles.metaRow}>
                <label className={`${styles.field} ${styles.grow}`}>
                  <span className={styles.eyebrow}>Title</span>
                  <input
                    className={styles.input}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Avg card tip · 30d"
                    autoComplete="off"
                  />
                </label>

                <div className={styles.field}>
                  <span className={styles.eyebrow}>Kind</span>
                  <SegmentedControl<BoardTileKind>
                    aria-label="Kind"
                    options={[...TILE_KINDS]}
                    value={kind}
                    onChange={setKind}
                  />
                </div>

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
              </div>

              {error ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}

              <div className={styles.actionRow}>
                <Button
                  variant="danger"
                  onClick={() => setConfirmingRemove(true)}
                  disabled={busy}
                >
                  Delete tile
                </Button>
                <div className={styles.grow} />
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => save(slot.draft)}
                  disabled={busy}
                >
                  {pending ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </div>
          )}
        />
      )}

      <Modal
        open={confirmingRemove}
        onClose={() => setConfirmingRemove(false)}
        title="Remove this tile?"
        icon="✕"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmingRemove(false)}>Cancel</Button>
            <Button variant="danger" onClick={remove} disabled={removing}>
              {removing ? "Removing…" : "Remove tile"}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          <strong>{tile.title}</strong> will be removed from this dashboard. Its
          query is stored on the tile, so removing it discards that too.
        </p>
      </Modal>
    </>
  );
}

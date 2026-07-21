"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  SegmentedControl,
  type ChartSpec,
} from "@/components/ui";
import { ChartStudio, type StudioSlot } from "@/components/shared/ChartStudio";
import {
  getTileEditorMaxDateAction,
  getTileEditorSchemaAction,
  runTileDraftAction,
} from "@/app/boards/actions";
import {
  TILE_KINDS,
  TILE_UNITS,
  type BoardActions,
} from "../model";
import type { BoardTileKind } from "@/types/db";
import styles from "../BoardForms.module.css";

/**
 * The starter query the studio opens on.
 *
 * The studio only draws its SQL box (and Run) when the spec carries a query, so a
 * create panel has to seed *something* — an empty spec would open a chartless
 * shell with nowhere to type. This is a template, not a runnable statement: the
 * author swaps db.table for the real source, Runs to preview, then Creates.
 * Dataset-agnostic by construction — nothing here names a real table, matching
 * the placeholder the old Add-tile modal showed in its SQL box.
 */
const STARTER_SQL = "select *\nfrom db.table\nlimit 100";

/**
 * Create a tile ON the ChartStudio — the CREATE mirror of TileEditor, hosted in
 * the board's PUSH PANEL rather than the modal it used to be (AddTileModal). It
 * shares the editor's surface and chrome: the studio, a config header
 * (title/kind/unit), and a footer action aligned under the query's Run.
 *
 * It differs from TileEditor exactly where a create must:
 *
 * NO DRAFT TO LOAD. Nothing exists yet, so there is no server round trip to
 * pre-fill from — the panel opens instantly on an empty table, seeded from the
 * starter query above. The author writes the real query and Runs it to preview
 * before creating; a create with no rows yet is simply an empty stage, not an
 * error.
 *
 * NO DELETE, ONE PRIMARY ACTION. There is nothing to remove, so the footer
 * carries a single "Create tile" where the editor carries Delete + Save. It sits
 * to the right, aligned under Run, the way the editor's Save does.
 *
 * ADD, NOT UPDATE. Success calls actions.addTile (the same write the modal
 * called), then closes the panel and asks the board to re-run so the new tile
 * appears with its rows.
 */
export function TileCreator({
  boardId,
  actions,
  onClose,
  onCreated,
}: {
  boardId: string;
  actions: BoardActions;
  /** Close the panel. Wired to the board's panel state. */
  onClose: () => void;
  /**
   * Ask the board to re-run its tiles once the new one is added. Same reason
   * TileEditor's onSaved is not optional politeness: the results live in
   * BoardDetail keyed on tile ids, and a router refresh alone re-renders only the
   * tile shells — without this the new tile appears with no rows until the next
   * poll. Optional because the board also mounts this on an empty board, where
   * there is nothing yet to have gone stale.
   */
  onCreated?: () => void;
}) {
  const router = useRouter();

  const [kind, setKind] = useState<BoardTileKind>("kpi");
  const [title, setTitle] = useState("");
  const [unit, setUnit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startCreate] = useTransition();
  const [schema, setSchema] = useState<
    Record<string, Record<string, string[]>> | undefined
  >();

  // The autocomplete namespace: loaded once per mount, optional. The panel opens
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

  // A table renders every column as-is; there is no single number to format, so
  // the unit picker only applies to a KPI or a chart.
  const showUnit = kind !== "table";

  /**
   * A minimal spec whose only job is to carry the starter SQL into the studio.
   * Empty channels and no data mean the studio renders a table (empty until the
   * first Run), which is the honest view of a query not yet written. Static, so
   * it never changes identity and the studio seeds its draft from it exactly
   * once.
   */
  const seedSpec = useMemo<ChartSpec>(
    () => ({
      chartType: "Bar Chart",
      title: "New tile",
      encodings: {},
      data: [],
      sql: STARTER_SQL,
    }),
    [],
  );

  const create = (draftSql: string) => {
    const finalTitle = title.trim();
    const finalSql = draftSql.trim();
    if (!finalTitle) return setError("Give the tile a title.");
    if (!finalSql) return setError("The tile needs a query.");

    setError(null);
    startCreate(async () => {
      const result = await actions.addTile({
        target: { kind: "existing", boardId },
        kind,
        title: finalTitle,
        sql: finalSql,
        ...(showUnit && unit ? { unit } : {}),
      });
      if (result.ok) {
        onClose();
        onCreated?.();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <ChartStudio
      spec={seedSpec}
      onRun={(sql) => runTileDraftAction(sql)}
      {...(schema ? { schema } : {})}
      resolveMaxDate={getTileEditorMaxDateAction}
      actions={(_slot: StudioSlot) => (
        // The panel draws no close of its own (showClose={false}); the studio
        // toolbar carries it, matching the tile editor and the chat's workspace.
        <button
          type="button"
          className={_slot.buttonClass}
          onClick={onClose}
          aria-label="Close the tile creator"
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}
      header={(_slot: StudioSlot) => (
        <div className={styles.studioHead}>
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
          </div>
        </div>
      )}
      footer={(slot: StudioSlot) => (
        <div className={styles.studioFoot}>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          {/* One primary action, at the foot under the query, aligned under Run
              the way the editor's Save is. No Delete (nothing exists yet) and no
              Cancel — the studio toolbar's ✕ already closes the panel. */}
          <div className={styles.actionRow}>
            <div className={styles.grow} />
            <Button
              variant="primary"
              onClick={() => create(slot.draft)}
              disabled={pending}
            >
              {pending ? "Creating…" : "Create tile"}
            </Button>
          </div>
        </div>
      )}
    />
  );
}

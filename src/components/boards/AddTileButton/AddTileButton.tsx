"use client";

import { Button } from "@/components/ui/Button";

/**
 * The "+ Add tile" trigger. Nothing more: the create form used to live here as a
 * Modal (AddTileModal), but a tile is now created ON the board's push panel — the
 * same ChartStudio surface its edit uses — so the form moved to
 * BoardDetail/TileCreator and this is just the button that opens the panel.
 *
 * The board owns which panel is open (create or an edit, never both), so the
 * click is handed up rather than kept here.
 */
export function AddTileButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" icon="＋" onClick={onClick}>
      Add tile
    </Button>
  );
}

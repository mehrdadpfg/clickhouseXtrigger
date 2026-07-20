"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ChartSpec } from "@/components/ui";

/**
 * Which chart the workspace is showing. `id` is the chart's tool-call id, so
 * re-opening the same chart is a no-op rather than a remount.
 */
export interface WorkspaceChart {
  id: string;
  spec: ChartSpec;
  /** The reader's chart-type pick from the tile, so it opens as it was seen. */
  view: string;
}

interface WorkspaceValue {
  current: WorkspaceChart | null;
  isOpen: boolean;
  open: (chart: WorkspaceChart) => void;
  close: () => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

/**
 * Holds the one chart the canvas is working on.
 *
 * Deliberately thin. Its ancestor — the Analyze provider this replaces — also
 * held every analysed chart of the chat, per-chart expanded sections, and cached
 * verb and Compare runs, which is what turned the panel into a second app. One
 * chart at a time needs none of that: opening another simply swaps it.
 *
 * It lives above the thread because the canvas uses a push layout, so the shell
 * has to be a sibling of the thread rather than a child of a chart tile.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<WorkspaceChart | null>(null);

  const open = useCallback((chart: WorkspaceChart) => setCurrent(chart), []);
  const close = useCallback(() => setCurrent(null), []);

  const value = useMemo(
    () => ({ current, isOpen: current !== null, open, close }),
    [current, open, close],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error("useWorkspace must be used inside a WorkspaceProvider");
  }
  return value;
}

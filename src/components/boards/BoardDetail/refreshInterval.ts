import { useCallback, useEffect, useState } from "react";

/**
 * How often an open board re-runs itself, per reader.
 *
 * OFF IS THE DEFAULT AND HAS TO BE. Every tile is an unbounded query somebody
 * wrote by hand; the board has no idea whether re-running it costs 50ms or the
 * 30s ceiling in READONLY_SETTINGS. Polling is therefore a choice the person who
 * opened the board makes deliberately, not one the board makes on their behalf
 * the moment it loads.
 *
 * The cadence lives in localStorage rather than on the board row for the same
 * reason it is not a board setting: stored server-side it would be a property of
 * the board and would commit every viewer — including a background tab somebody
 * forgot — to whatever the last editor picked. How closely one person is
 * watching right now is theirs alone.
 */
export const REFRESH_INTERVALS = [
  { value: "off", label: "Off", ms: null },
  { value: "30s", label: "30s", ms: 30_000 },
  { value: "1m", label: "1m", ms: 60_000 },
  { value: "5m", label: "5m", ms: 300_000 },
  { value: "15m", label: "15m", ms: 900_000 },
] as const satisfies readonly { value: string; label: string; ms: number | null }[];

export type RefreshInterval = (typeof REFRESH_INTERVALS)[number]["value"];

const DEFAULT_INTERVAL: RefreshInterval = "off";

/** Milliseconds between runs, or null when auto-refresh is off. */
export function intervalMsOf(value: RefreshInterval): number | null {
  return REFRESH_INTERVALS.find((option) => option.value === value)?.ms ?? null;
}

/**
 * Anything else in storage — a hand-edited value, a cadence this build no longer
 * offers — reads as absent and the default stands. localStorage is user-writable
 * and survives a deploy, so it is untrusted input like any other.
 */
function isInterval(raw: string | null): raw is RefreshInterval {
  return REFRESH_INTERVALS.some((option) => option.value === raw);
}

function storageKey(boardId: string): string {
  return `vantage.boards.refresh.${boardId}`;
}

/**
 * The reader's cadence for one board, remembered across reloads.
 *
 * Follows ChatPrefs: read after mount, never during render, so the server render
 * and the first client render both say "off" and there is no hydration
 * mismatch — and every touch of localStorage is wrapped, because it throws
 * outright in privacy mode rather than returning null.
 */
export function useRefreshInterval(
  boardId: string,
): [RefreshInterval, (next: RefreshInterval) => void] {
  const [interval, setInterval] = useState<RefreshInterval>(DEFAULT_INTERVAL);

  useEffect(() => {
    // Reset first: the id can change under a live mount (one board's route
    // segment replaced by another's), and inheriting the previous board's
    // cadence would start polling a board nobody chose to poll.
    setInterval(DEFAULT_INTERVAL);
    try {
      const stored = window.localStorage.getItem(storageKey(boardId));
      if (isInterval(stored)) setInterval(stored);
    } catch {
      // Off stands.
    }
  }, [boardId]);

  const choose = useCallback(
    (next: RefreshInterval) => {
      setInterval(next);
      try {
        window.localStorage.setItem(storageKey(boardId), next);
      } catch {
        // Non-fatal — the choice just won't survive a reload.
      }
    },
    [boardId],
  );

  return [interval, choose];
}

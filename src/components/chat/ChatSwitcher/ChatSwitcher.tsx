"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/ui";
import {
  listChatsForSwitcher,
  type ChatListItem,
  searchCharts,
  type ChartHit,
} from "@/app/chats/actions";
import { relativeTime } from "../HistorySidebar/relativeTime";

/**
 * The chat list, as a searchable modal — the replacement for the old always-on
 * history sidebar. It loads the list lazily the first time it opens (so the four
 * sections don't each pay for it), and filters by title in the browser: the list
 * is capped at 50, small enough that a keystroke filter needs no round trip.
 *
 * A row is a Link, not a button, so it prefetches and middle-clicks like one;
 * choosing a thread navigates and closes the modal.
 */
export function ChatSwitcher({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ChatListItem[] | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Charts are searched on the SERVER: unlike chat titles, they aren't in the
  // list already — a title lives inside a message's jsonb, so finding one means
  // asking the database.
  const [charts, setCharts] = useState<ChartHit[]>([]);

  // Re-read on every open: a thread asked since last time should show up, and a
  // new watcher should light its row. Cheap enough (one indexed list query).
  useEffect(() => {
    if (!open) return;
    let live = true;
    setQuery("");
    setCharts([]);
    void listChatsForSwitcher().then((rows) => {
      if (live) setItems(rows);
    });
    return () => {
      live = false;
    };
  }, [open]);

  // Debounced so a fast typist doesn't queue a scan per keystroke.
  useEffect(() => {
    const term = query.trim();
    if (!open || term.length < 2) {
      setCharts([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void searchCharts(term).then((hits) => {
        if (live) setCharts(hits);
      });
    }, 220);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, open]);

  const now = useMemo(() => new Date(), [items]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = items ?? [];
    return q ? rows.filter((r) => r.title.toLowerCase().includes(q)) : rows;
  }, [items, query]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Chats"
      size="xl"
      hideHeader
      initialFocusRef={searchRef}
    >
      <div className="flex flex-col gap-3">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats, chart titles, or SQL…"
          aria-label="Search chats and charts"
          className="w-full rounded-[var(--r-lg)] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2.5 text-[14px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-accent)]"
        />

        <div className="-mx-1 flex max-h-[40dvh] flex-col overflow-y-auto px-1">
          {items === null ? (
            <p className="px-1 py-8 text-center text-[13px] text-[var(--text-muted)]">
              Loading…
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-1 py-8 text-center text-[13px] text-[var(--text-muted)]">
              {items.length === 0
                ? "No chats yet. Start one from the ✎ button."
                : charts.length > 0
                  ? "No chat titles match — see the charts below."
                  : "Nothing matches that search."}
            </p>
          ) : (
            filtered.map((item) => (
              <Row key={item.id} item={item} now={now} onNavigate={onClose} />
            ))
          )}

          {charts.length > 0 ? (
            <>
              <div className="mt-3 px-1 pb-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--text-muted)]">
                Charts
              </div>
              {charts.map((hit) => (
                <ChartRow
                  key={`${hit.chatId}:${hit.chartTitle}`}
                  hit={hit}
                  onNavigate={onClose}
                />
              ))}
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function Row({
  item,
  now,
  onNavigate,
}: {
  item: ChatListItem;
  now: Date;
  onNavigate: () => void;
}) {
  const live = item.liveWatchers > 0;

  return (
    <Link
      href={`/chats/${item.id}`}
      onClick={onNavigate}
      className="group flex items-center gap-3 rounded-[var(--r-md)] px-2.5 py-2.5 no-underline transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:bg-[var(--accent-bg)]"
    >
      {live ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-[var(--good)]"
          aria-hidden="true"
        />
      ) : (
        <span className="size-1.5 shrink-0" aria-hidden="true" />
      )}

      <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--text)]">
        {item.title}
      </span>

      <span className="tnum shrink-0 text-[12px] text-[var(--text-muted)]">
        {live
          ? `${item.liveWatchers} watcher${item.liveWatchers === 1 ? "" : "s"} live · `
          : ""}
        {relativeTime(new Date(item.isoTime), now)}
      </span>
    </Link>
  );
}

/**
 * One chart hit.
 *
 * The chat's name and time sit under the chart title deliberately: titles are
 * neither unique nor stable, and a list of six near-identical
 * "NYC Evictions per Year…" rows is useless without them.
 */
function ChartRow({
  hit,
  onNavigate,
}: {
  hit: ChartHit;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={`/chats/${hit.chatId}`}
      onClick={onNavigate}
      className="flex flex-col gap-0.5 rounded-[var(--r-md)] px-3 py-2 no-underline hover:bg-[var(--raised)]"
    >
      <span className="truncate text-[13.5px] text-[var(--text)]">
        {hit.chartTitle}
      </span>
      <span className="truncate font-mono text-[11px] text-[var(--text-muted)]">
        {hit.chatTitle} · {relativeTime(new Date(hit.isoTime), new Date())}
      </span>
    </Link>
  );
}

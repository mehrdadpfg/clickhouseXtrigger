"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./HistorySidebar.module.css";

/**
 * One sidebar row, already reduced to what the sidebar draws.
 *
 * Plain, serialisable data: this component is a client island, so what crosses
 * the boundary is titles and counts — never a ChatRow, and never anything that
 * came from lib/db's connection.
 */
export interface HistoryItem {
  id: string;
  title: string;
  /** Pre-formatted server-side — see relativeTime for why. */
  timeLabel: string;
  /** Machine-readable stamp behind the label, for <time datetime>. */
  isoTime: string;
  /** Live watchers attached to this chat. 0 for most rows. */
  liveWatchers: number;
}

export interface HistorySidebarProps {
  items: HistoryItem[];
  /** Postgres didn't answer. An empty list would be a lie, so it's said out loud. */
  error?: string;
}

/**
 * Client, for one reason: the active row. The list itself is server data, but
 * which row is current is a function of the URL, and this sits in a layout —
 * which has no params of its own. usePathname is the honest way to read it, and
 * keeps the sidebar mounted (and unscrolled) across chat switches.
 */
export function HistorySidebar({ items, error }: HistorySidebarProps) {
  const pathname = usePathname();

  return (
    <aside className={styles.sidebar} aria-label="Chat history">
      <div className={styles.head}>
        <span className={styles.eyebrow}>History</span>
        {/* "/" is where a chat id is minted, so New chat is a link, not a
            button: it navigates, and should middle-click like a link. */}
        <Link href="/" className={styles.new}>
          <span aria-hidden="true">＋</span> New chat
        </Link>
      </div>

      <nav className={styles.list}>
        {error ? (
          <p className={styles.note}>
            Couldn&rsquo;t load chats — {error}
          </p>
        ) : items.length === 0 ? (
          <p className={styles.note}>
            No chats yet. Ask something and it&rsquo;ll show up here.
          </p>
        ) : (
          items.map((item) => (
            <Row key={item.id} item={item} active={isActive(pathname, item.id)} />
          ))
        )}
      </nav>
    </aside>
  );
}

function isActive(pathname: string, id: string): boolean {
  return pathname === `/chats/${id}`;
}

function Row({ item, active }: { item: HistoryItem; active: boolean }) {
  const live = item.liveWatchers > 0;

  return (
    <Link
      href={`/chats/${item.id}`}
      className={[styles.row, active ? styles.active : null]
        .filter(Boolean)
        .join(" ")}
      aria-current={active ? "page" : undefined}
    >
      <span className={styles.titleRow}>
        {/* The pulsing dot is decorative: the meta line below spells out
            "1 watcher live", so the marker never rests on colour alone. */}
        {live ? <span className={styles.dot} aria-hidden="true" /> : null}
        <span className={styles.title}>{item.title}</span>
      </span>

      <span
        className={[
          "tnum",
          styles.meta,
          live ? styles.metaInset : null,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <time dateTime={item.isoTime}>{item.timeLabel}</time>
        {live ? ` · ${item.liveWatchers} watcher${item.liveWatchers === 1 ? "" : "s"} live` : null}
      </span>
    </Link>
  );
}

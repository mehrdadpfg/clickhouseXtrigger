import type { ReactNode } from "react";
import {
  HistorySidebar,
  relativeTime,
  type HistoryItem,
} from "@/components/chat/HistorySidebar";
import { listChats } from "@/lib/db/chats";
import { listActiveWatchers } from "@/lib/db/watchers";
import styles from "./layout.module.css";

/**
 * The frame both "/chats" and "/chats/:id" render inside.
 *
 * A layout, not a per-page fetch: the sidebar then survives navigation between
 * threads — it keeps its scroll position and doesn't re-fetch the list on every
 * chat you click.
 *
 * An RSC, so lib/db is read here and only finished strings cross into the
 * client island. The connection never leaves the server.
 */
export const dynamic = "force-dynamic";

async function loadHistory(): Promise<{
  items: HistoryItem[];
  error?: string;
}> {
  try {
    // Two independent reads — no reason to pay for them in series.
    const [chats, watchers] = await Promise.all([
      listChats(),
      listActiveWatchers(),
    ]);

    // One pass over the active watchers beats asking per chat: the sidebar
    // renders 50 rows, and this is the difference between 1 query and 51.
    const live = new Map<string, number>();
    for (const watcher of watchers) {
      // A watcher outlives the chat it was born in (chat_id -> null).
      if (!watcher.chat_id) continue;
      live.set(watcher.chat_id, (live.get(watcher.chat_id) ?? 0) + 1);
    }

    const now = new Date();
    const items = chats.map((chat) => {
      // The sidebar is ordered by activity, so it dates rows by activity too;
      // an unstarted chat falls back to when it was created.
      const at = chat.last_message_at ?? chat.created_at;
      return {
        id: chat.id,
        title: chat.title,
        isoTime: at.toISOString(),
        timeLabel: relativeTime(at, now),
        liveWatchers: live.get(chat.id) ?? 0,
      };
    });

    return { items };
  } catch (cause) {
    // Postgres holds the chat *index*; the thread itself lives in Trigger. A
    // dead index must not take the conversation down with it — the sidebar
    // says so and the thread beside it still works.
    console.error("History sidebar load failed", cause);
    return {
      items: [],
      error: cause instanceof Error ? cause.message : "could not load chats",
    };
  }
}

export default async function ChatsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { items, error } = await loadHistory();

  return (
    <div className={styles.page}>
      <HistorySidebar items={items} error={error} />
      {children}
    </div>
  );
}

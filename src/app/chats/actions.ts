"use server";

import { revalidatePath } from "next/cache";
import { createChat, getChat, listChats, touchChat } from "@/lib/db/chats";
import { listActiveWatchers } from "@/lib/db/watchers";
import { getChatMessages as readChatMessages } from "@/lib/db/messages";
import {
  deleteSession as removeSession,
  getSession as readSession,
  saveSession as writeSession,
  type SessionState,
} from "@/lib/db/sessions";
import type { UIMessage } from "ai";
import { runReadonlyQueryWithCost, type QueryCost } from "@/lib/clickhouse/run";
import { columnNamespace } from "@/lib/clickhouse/introspect";

/** Sidebar titles are one line — a question longer than this is clipped to it. */
const TITLE_MAX = 80;

function toTitle(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean;
}

/**
 * Puts the chat in the sidebar, on the first message.
 *
 * The Start screen mints a chat id and navigates; nothing writes it down. The
 * row is created here rather than when the thread page renders, because that
 * render is a GET — opening a link, or a prefetch, would otherwise create a
 * chat that was never asked anything.
 *
 * Only the list metadata is written. The messages themselves live in the
 * Trigger session, keyed by the same id (see ARCHITECTURE, "Two datastores").
 */
export async function recordChat(chatId: string, question: string) {
  const title = toTitle(question);
  if (!title) return;

  try {
    // Two turns in one thread reach this once (the caller fires on the first
    // user message only), but a double-submit or a re-mount could race it.
    if (await getChat(chatId)) {
      await touchChat(chatId);
    } else {
      try {
        await createChat({ id: chatId, title });
      } catch {
        // Lost the insert race — the row exists, which is all we wanted.
        await touchChat(chatId);
      }
    }

    // The sidebar is rendered by the /chats layout, so the layout is what has
    // to be rebuilt — revalidating the page alone leaves the list stale.
    revalidatePath("/chats", "layout");
  } catch (cause) {
    // A chat that isn't listed is a worse thread than one that is, but it is
    // still a working thread: never take the conversation down over the index.
    console.error("Could not record chat", chatId, cause);
  }
}

/** One row in the chat-switcher modal — plain data for a client island. */
export interface ChatListItem {
  id: string;
  title: string;
  /** ISO stamp of last activity; the switcher formats it client-side. */
  isoTime: string;
  /** Live watchers born in this chat, so the row can flag an active thread. */
  liveWatchers: number;
}

/**
 * The chat list behind the switcher modal, newest-active first. Loaded lazily
 * when the modal opens (not on every page), so it stays a client-triggered read
 * rather than layout weight on all four sections. Search is a title filter the
 * client applies over this list — small enough (<=50) to filter in the browser.
 */
export async function listChatsForSwitcher(): Promise<ChatListItem[]> {
  try {
    const [chats, watchers] = await Promise.all([
      listChats(),
      listActiveWatchers(),
    ]);

    // One pass over active watchers: the switcher may render 50 rows, and this
    // is 1 query instead of 51.
    const live = new Map<string, number>();
    for (const watcher of watchers) {
      if (!watcher.chat_id) continue;
      live.set(watcher.chat_id, (live.get(watcher.chat_id) ?? 0) + 1);
    }

    return chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      isoTime: (chat.last_message_at ?? chat.created_at).toISOString(),
      liveWatchers: live.get(chat.id) ?? 0,
    }));
  } catch (cause) {
    // The index is not the conversation: a dead list must not throw into the
    // modal. An empty list is honest enough — the threads themselves still open.
    console.error("Chat switcher load failed", cause);
    return [];
  }
}

/**
 * Chat restore actions — the client component reads these on page load to
 * rehydrate a reloaded thread: the messages become useChat's `initialMessages`,
 * the session becomes the transport's `sessions` entry. saveSession/deleteSession
 * are the transport's `onSessionChange` sink. See ARCHITECTURE, "Two datastores".
 */

export async function getChatMessages(chatId: string): Promise<UIMessage[]> {
  return readChatMessages(chatId);
}

export async function getSession(chatId: string): Promise<SessionState | null> {
  return readSession(chatId);
}

export async function saveSession(
  chatId: string,
  state: SessionState,
): Promise<void> {
  await writeSession(chatId, state);
}

export async function deleteSession(chatId: string): Promise<void> {
  await removeSession(chatId);
}

/**
 * Run a query the reader edited in the chart workspace.
 *
 * This is the one path where ClickHouse SQL arrives from the browser —
 * lib/clickhouse/run's note that "the SQL is never taken from the browser"
 * describes the board tiles, which run stored SQL by id. An editable query box
 * cannot work that way.
 *
 * It is not a new capability: the chat agent already executes whatever SQL the
 * reader's question leads it to write, under exactly these guards. What changes
 * is the path, not the reach. READONLY_SETTINGS still bounds every run —
 * readonly=2 forbids writes and DDL, 30s caps runtime, 500 rows caps the
 * result — and the shape check below refuses anything that isn't a single
 * SELECT/WITH before ClickHouse is asked at all, so a malformed edit fails
 * here with a readable message rather than as a server error.
 */
export async function runWorkspaceQuery(
  sql: string,
): Promise<
  | { ok: true; rows: Record<string, unknown>[]; cost: QueryCost | null }
  | { ok: false; error: string }
> {
  const trimmed = sql.trim().replace(/;\s*$/, "");

  if (trimmed === "") return { ok: false, error: "The query is empty." };
  if (trimmed.includes(";")) {
    return { ok: false, error: "One statement at a time — remove the semicolon." };
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    return { ok: false, error: "Only SELECT (or WITH … SELECT) can run here." };
  }

  try {
    const { rows, cost } = await runReadonlyQueryWithCost(trimmed);
    return { ok: true, rows, cost };
  } catch (cause) {
    // ClickHouse errors are long and prefixed; the first line carries the point.
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message.split("\n")[0]!.slice(0, 300) };
  }
}

/**
 * The column namespace the query editor completes against.
 *
 * Cached in ClickHouse introspection, so repeated calls across a session cost
 * one sweep. Returns {} on failure rather than throwing: autocomplete is a
 * convenience, and an editor that still opens without it beats a workspace that
 * won't open at all.
 */
export async function getSchemaNamespace(): Promise<
  Record<string, Record<string, string[]>>
> {
  try {
    return await columnNamespace();
  } catch (cause) {
    console.error("Could not load the schema for autocomplete", cause);
    return {};
  }
}

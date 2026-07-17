/**
 * Chats — the history sidebar list.
 *
 * Only the list metadata lives here. The messages themselves are persisted by
 * Trigger.dev's chat session; this table exists so the sidebar can render
 * without booting every session.
 *
 * Server-only. Every value is passed as a bind parameter — never interpolated.
 */
import { query } from "@/lib/db/client";
import type { ChatRow } from "@/types/db";

const COLUMNS = "id, title, created_at, updated_at, last_message_at";

/** Sidebar order: most recently active first, unstarted chats by creation. */
const RECENT_ORDER = "order by coalesce(last_message_at, created_at) desc";

export async function listChats(limit = 50): Promise<ChatRow[]> {
  return query<ChatRow>(
    `select ${COLUMNS} from chats ${RECENT_ORDER} limit $1`,
    [limit],
  );
}

export async function getChat(id: string): Promise<ChatRow | null> {
  const rows = await query<ChatRow>(
    `select ${COLUMNS} from chats where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * `id` is optional so a caller can align the chat row with an id it already
 * owns (e.g. a Trigger session id) instead of minting a second identifier.
 */
export async function createChat(input: {
  title: string;
  id?: string;
}): Promise<ChatRow> {
  const rows = await query<ChatRow>(
    `insert into chats (id, title)
     values (coalesce($1::uuid, gen_random_uuid()), $2)
     returning ${COLUMNS}`,
    [input.id ?? null, input.title],
  );
  // insert ... returning always yields exactly one row.
  return rows[0]!;
}

export async function renameChat(
  id: string,
  title: string,
): Promise<ChatRow | null> {
  const rows = await query<ChatRow>(
    `update chats set title = $2, updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [id, title],
  );
  return rows[0] ?? null;
}

/** Mark activity — call when a message lands, to reorder the sidebar. */
export async function touchChat(
  id: string,
  at: Date = new Date(),
): Promise<ChatRow | null> {
  const rows = await query<ChatRow>(
    `update chats set last_message_at = $2, updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [id, at],
  );
  return rows[0] ?? null;
}

/** Returns false if the chat did not exist. Watchers born here survive (chat_id -> null). */
export async function deleteChat(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from chats where id = $1 returning id`,
    [id],
  );
  return rows.length > 0;
}

/**
 * Chat messages — the persisted conversation, one UIMessage per row.
 *
 * The Trigger.dev Session owns the live conversation while a run is alive; this
 * table is what a reloaded tab reads back as `initialMessages` before any run
 * exists. Written from the chat agent's onTurnComplete hook (see trigger/chat).
 *
 * Server-only. Every value is passed as a bind parameter — never interpolated.
 */
import { query } from "@/lib/db/client";
import type { UIMessage } from "ai";

/**
 * Upsert a turn's messages (the user message + the assistant response).
 *
 * Keyed on (chat_id, message_id): a re-delivered or edited message overwrites
 * its row rather than duplicating it. Written as a single multi-row statement so
 * a whole turn lands atomically.
 */
export async function saveMessages(
  chatId: string,
  messages: UIMessage[],
  turn: number,
): Promise<void> {
  if (messages.length === 0) return;

  const values: unknown[] = [];
  const rows: string[] = [];
  for (const message of messages) {
    const base = values.length;
    values.push(chatId, message.id, message.role, JSON.stringify(message), turn);
    rows.push(
      `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}::int)`,
    );
  }

  await query(
    `insert into chat_messages (chat_id, message_id, role, message, turn)
     values ${rows.join(", ")}
     on conflict (chat_id, message_id) do update
       set role    = excluded.role,
           message = excluded.message,
           turn    = excluded.turn`,
    values,
  );

  // The chat's recency belongs HERE, where a message actually lands.
  // It used to be stamped when the thread mounted, so merely opening a chat
  // pushed it to the top of the list and the history reshuffled every time you
  // read something — the order stopped meaning "most recently talked to".
  await query(`update chats set last_message_at = now() where id = $1::uuid`, [
    chatId,
  ]);
}

/** The conversation in load order, ready to hand to useChat as initialMessages. */
export async function getChatMessages(chatId: string): Promise<UIMessage[]> {
  const rows = await query<{ message: UIMessage }>(
    `select message from chat_messages
     where chat_id = $1
     order by turn,
              created_at,
              case role when 'user' then 0 when 'assistant' then 1 else 2 end`,
    [chatId],
  );
  // jsonb comes back already parsed by pg.
  return rows.map((r) => r.message);
}

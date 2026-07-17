/**
 * Chat sessions — the per-chat transport state a reloaded tab restores.
 *
 * The frontend transport keys a chat on its Session; on page load it needs the
 * session-scoped token and the last SSE event id back so it resubscribes to the
 * same Session instead of creating a new one. Written from the chat agent's
 * onTurnComplete hook and from the frontend's session-cleanup callback.
 *
 * Server-only. Every value is passed as a bind parameter — never interpolated.
 */
import { query } from "@/lib/db/client";

/** What the transport persists per chat. Mirrors the `sessions` option shape. */
export type SessionState = {
  publicAccessToken: string;
  /** Valid for the Session's lifetime; only cleared when the Session closes. */
  lastEventId?: string;
};

export async function getSession(chatId: string): Promise<SessionState | null> {
  const rows = await query<{
    public_access_token: string;
    last_event_id: string | null;
  }>(
    `select public_access_token, last_event_id
     from chat_sessions
     where chat_id = $1`,
    [chatId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    publicAccessToken: row.public_access_token,
    lastEventId: row.last_event_id ?? undefined,
  };
}

export async function saveSession(
  chatId: string,
  state: SessionState,
): Promise<void> {
  await query(
    `insert into chat_sessions (chat_id, public_access_token, last_event_id, updated_at)
     values ($1::uuid, $2, $3, now())
     on conflict (chat_id) do update
       set public_access_token = excluded.public_access_token,
           last_event_id       = excluded.last_event_id,
           updated_at          = now()`,
    [chatId, state.publicAccessToken, state.lastEventId ?? null],
  );
}

export async function deleteSession(chatId: string): Promise<void> {
  await query(`delete from chat_sessions where chat_id = $1`, [chatId]);
}

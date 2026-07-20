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
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { query } from "@/lib/db/client";

/** What the transport persists per chat. Mirrors the `sessions` option shape. */
export type SessionState = {
  publicAccessToken: string;
  /** Valid for the Session's lifetime; only cleared when the Session closes. */
  lastEventId?: string;
};

/**
 * When any task source was last edited, or 0 if the directory can't be read.
 *
 * A Trigger Session pins to the worker version it started on, so a chat that
 * began before a tool was added keeps running the OLD tool definitions while new
 * chats get the new ones — silently, and with symptoms that look like the model
 * misbehaving rather than a stale build. (Seen twice: askThreshold never firing,
 * then renderChart omitting a REQUIRED `sql` field, which a current schema would
 * have rejected outright.)
 *
 * Nothing in the transport reports the worker version to this app, so instead of
 * asking "is the session current?" — unanswerable here — it asks the question
 * that actually matters: was a tool edited AFTER this session started? That is
 * observable straight off the filesystem, and it models the real causality.
 *
 * Dev only. In production, tasks are deployed as versions and sessions ending
 * with one is expected behaviour, not a trap.
 */
async function taskSourcesTouchedAt(): Promise<number> {
  try {
    const dir = path.join(process.cwd(), "src", "trigger");
    const names = await readdir(dir);
    const times = await Promise.all(
      names.map(async (name) => (await stat(path.join(dir, name))).mtimeMs),
    );
    return times.length > 0 ? Math.max(...times) : 0;
  } catch {
    return 0;
  }
}

export async function getSession(chatId: string): Promise<SessionState | null> {
  const rows = await query<{
    public_access_token: string;
    last_event_id: string | null;
    created_at: Date;
  }>(
    `select public_access_token, last_event_id, created_at
     from chat_sessions
     where chat_id = $1`,
    [chatId],
  );
  const row = rows[0];
  if (!row) return null;

  if (process.env.NODE_ENV !== "production") {
    const touched = await taskSourcesTouchedAt();
    // created_at, NOT updated_at: saveSession bumps updated_at on every turn, so
    // a stale session refreshes its own timestamp and would always look current.
    if (touched > row.created_at.getTime()) {
      // Drop it rather than resume onto stale tools. The next message opens a
      // fresh Session on the current worker; the conversation itself is safe,
      // since chat_messages is what a reload actually reads back.
      await deleteSession(chatId);
      return null;
    }
  }

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
    `insert into chat_sessions (chat_id, public_access_token, last_event_id, created_at, updated_at)
     values ($1::uuid, $2, $3, now(), now())
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

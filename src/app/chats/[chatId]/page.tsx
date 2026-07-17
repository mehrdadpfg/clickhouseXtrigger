import { Chat } from "@/components/chat/Chat";
import { getChat } from "@/lib/db/chats";
import { getChatMessages } from "@/lib/db/messages";
import { getSession, type SessionState } from "@/lib/db/sessions";
import { listTables } from "@/lib/clickhouse/introspect";
import type { UIMessage } from "ai";

/**
 * "/chats/:id" — the thread.
 *
 * The conversation itself lives in Trigger.dev, keyed by the chatId in the URL,
 * so there is no history to load here. What this route does load is the two
 * things the header names: what the thread is called, and which table it is
 * pointed at — the latter read from the live schema, never written down.
 */
export const dynamic = "force-dynamic";

/**
 * The dataset the header names.
 *
 * With no configured table name to go on, the biggest one wins — the same rule
 * the Start screen picks by, so the header agrees with the screen the thread
 * was opened from.
 */
async function loadDataset(): Promise<string | null> {
  try {
    const tables = await listTables();
    const biggest = [...tables].sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0))[0];
    return biggest ? `${biggest.database}.${biggest.name}` : null;
  } catch (cause) {
    // A dead ClickHouse costs the header its pill. It must not cost the reader
    // the thread — the agent's own errors are a better place to learn that.
    console.error("Thread header introspection failed", cause);
    return null;
  }
}

async function loadTitle(chatId: string): Promise<string | null> {
  try {
    return (await getChat(chatId))?.title ?? null;
  } catch (cause) {
    console.error("Thread title lookup failed", cause);
    return null;
  }
}

/**
 * The persisted conversation + transport state a reloaded tab restores.
 *
 * Shape matches what the frontend wiring needs:
 *   - `initialMessages` -> useChat({ messages, resume: messages.length > 0 })
 *   - `initialSessions` -> useTriggerChatTransport({ sessions }), keyed by chatId
 *
 * Exported so the frontend-wiring step can call it from the route (or a client
 * effect) once <Chat> accepts these props. A dead DB costs the reload its
 * history, not the thread — the live Trigger Session still answers.
 */
export async function loadInitialChatState(chatId: string): Promise<{
  initialMessages: UIMessage[];
  initialSessions: Record<string, SessionState> | undefined;
}> {
  try {
    const [messages, session] = await Promise.all([
      getChatMessages(chatId),
      getSession(chatId),
    ]);
    return {
      initialMessages: messages,
      initialSessions: session ? { [chatId]: session } : undefined,
    };
  } catch (cause) {
    console.error("Thread history restore failed", cause);
    return { initialMessages: [], initialSessions: undefined };
  }
}

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ chatId: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { chatId } = await params;
  const { q } = await searchParams;

  // ?q=a&q=b is a malformed URL, not a second question — take the first.
  const first = Array.isArray(q) ? q[0] : q;
  const question = first?.trim();

  const [title, dataset] = await Promise.all([
    loadTitle(chatId),
    loadDataset(),
  ]);

  // TODO(frontend-wiring): once <Chat> accepts `initialMessages` /
  // `initialSessions`, load them here via `loadInitialChatState(chatId)` and
  // pass them through so a reloaded thread isn't empty. Not passed yet: Chat
  // (owned by the migration workflow) doesn't declare these props, so adding
  // them now would be a tsc error. The loader is exported above, ready to wire.

  return (
    <Chat
      chatId={chatId}
      initialQuestion={question || undefined}
      // A chat is only written down once it has been asked something, so a
      // thread arriving from Start has no row yet: the question it was opened
      // with is its name until the first message lands and makes that real.
      title={title ?? question ?? "New chat"}
      dataset={dataset}
    />
  );
}

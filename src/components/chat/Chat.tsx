"use client";

import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { useChat } from "@ai-sdk/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { UIMessage } from "ai";
import type { clickhouseChat } from "@/trigger/chat";
import type { SessionState } from "@/lib/db/sessions";
import { mintChatAccessToken, startChatSession } from "@/app/actions";
import { deleteSession, recordChat } from "@/app/chats/actions";
import { AgentTurn } from "./AgentTurn";
import { ChatPrefsProvider, ChatSettings } from "./ChatPrefs";
import styles from "./Chat.module.css";

export function Chat({
  chatId,
  initialQuestion,
  initialMessages,
  initialSessions,
  title,
  dataset,
}: {
  /** Minted by whoever opened the thread; keys the Trigger Session. */
  chatId: string;
  /** The question the Start screen handed over, asked once on arrival. */
  initialQuestion?: string;
  /** Persisted turns, so a reloaded tab isn't empty. Loaded by the route. */
  initialMessages: UIMessage[];
  /** Per-chat transport state (token + stream cursor) to resume the Session. */
  initialSessions: Record<string, SessionState> | undefined;
  /** The thread's name in the header. */
  title: string;
  /**
   * The table this thread is pointed at, introspected by the route at request
   * time — "db.table". Null when ClickHouse didn't answer.
   */
  dataset: string | null;
}) {
  const transport = useTriggerChatTransport<typeof clickhouseChat>({
    task: "clickhouse-chat",
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) =>
      startChatSession({ chatId, clientData }),
    // Restored from Postgres so a reload resubscribes to the same Session
    // (via its lastEventId) instead of opening a new one.
    sessions: initialSessions,
    onSessionChange: (id, session) => {
      // A null session means the run ended — drop the persisted cursor so the
      // next message starts a fresh continuation rather than a stale resubscribe.
      if (!session) void deleteSession(id);
    },
  });

  // Raw useChat (not useChatRuntime): useChatRuntime invents its own local
  // thread id (__LOCALID_…) and hands THAT to the transport, so the Trigger
  // Session — and onTurnComplete's chatId — end up keyed by a non-uuid we can't
  // persist or reload by. useChat threads our `id` straight through to the
  // transport, so the Session is keyed by the real chatId. `messages` seeds the
  // thread from persisted history; `resume` reconnects an in-flight stream on
  // reload via the restored session cursor.
  const chat = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
    resume: initialMessages.length > 0,
  });
  const runtime = useAISDKRuntime(chat);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SeedFirstQuestion runtime={runtime} question={initialQuestion} />
      <RecordChat chatId={chatId} />
      <ChatPrefsProvider>
        <Thread />
      </ChatPrefsProvider>
    </AssistantRuntimeProvider>
  );
}

/**
 * Sends the ?q= question the Start screen passed over, exactly once.
 *
 * The ref guards against StrictMode's double-effect; dropping ?q= from the URL
 * guards against a reload asking the same thing twice. `replace`, not `push`,
 * so Back still returns to Start rather than to this page minus its query.
 */
function SeedFirstQuestion({
  runtime,
  question,
}: {
  runtime: ReturnType<typeof useAISDKRuntime>;
  question?: string;
}) {
  const router = useRouter();
  const sent = useRef(false);

  useEffect(() => {
    if (!question || sent.current) return;
    sent.current = true;
    runtime.thread.append(question);
    router.replace(window.location.pathname, { scroll: false });
  }, [question, runtime, router]);

  return null;
}

/**
 * Writes the chat into the sidebar's list once it has a first question — the
 * question is the title. Fires on the message rather than on mount so that
 * opening a thread and asking nothing doesn't leave an empty row behind.
 */
function RecordChat({ chatId }: { chatId: string }) {
  const router = useRouter();
  const first = useAuiState((s) =>
    s.thread.messages.find((m) => m.role === "user"),
  );
  const recorded = useRef(false);

  useEffect(() => {
    if (recorded.current || !first) return;

    const text = first.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ")
      .trim();
    if (!text) return;

    recorded.current = true;
    // The sidebar lives in a shared, persistent layout that client navigation
    // preserves, so recordChat's server-side revalidatePath never reaches the
    // client router. Refresh once the row exists so the new chat appears — the
    // assistant-ui runtime is client state and survives the refresh, so an
    // in-flight response keeps streaming.
    void recordChat(chatId, text).then(() => router.refresh());
  }, [chatId, first, router]);

  return null;
}

function Thread() {
  // An empty thread centres the greeting + composer instead of stranding the
  // composer at the bottom under a tall void.
  const isEmpty = useAuiState((s) => s.thread.messages.length === 0);
  return (
    <ThreadPrimitive.Root
      className={isEmpty ? `${styles.chat} ${styles.chatEmpty}` : styles.chat}
    >

      <ThreadPrimitive.Viewport className={styles.viewport}>
        <div className={styles.column}>
          <AuiIf condition={(s) => s.thread.messages.length === 0}>
            <p className={styles.empty}>
              Ask a question in plain language. The agent reads the schema,
              writes the SQL, and shows its work.
            </p>
          </AuiIf>

          <ThreadPrimitive.Messages>
            {({ message }) =>
              message.role === "user" ? <UserTurn /> : <AgentTurn />
            }
          </ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>

      <div className={styles.composerBar}>
        <div className={styles.column}>
          <ComposerPrimitive.Root className={styles.composer}>
            {/* Renders a <textarea>, styled via `.composer textarea`. */}
            <ComposerPrimitive.Input
              rows={1}
              placeholder="Ask a follow-up, or describe a chart to build…"
            />
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send className={styles.send} aria-label="Send">
                <span aria-hidden="true">↑</span>
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(s) => s.thread.isRunning}>
              <ComposerPrimitive.Cancel
                className={styles.send}
                aria-label="Stop"
              >
                <span aria-hidden="true">■</span>
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </ComposerPrimitive.Root>
          <ChatSettings />
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}

function UserTurn() {
  return (
    <MessagePrimitive.Root className={styles.userTurn}>
      <div className={styles.bubble}>
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

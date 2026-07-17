"use client";

import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { clickhouseChat } from "@/trigger/chat";
import { mintChatAccessToken, startChatSession } from "@/app/actions";
import { recordChat } from "@/app/chats/actions";
import { AgentTurn } from "./AgentTurn";
import styles from "./Chat.module.css";

export function Chat({
  chatId,
  initialQuestion,
  title,
  dataset,
}: {
  /** Minted by whoever opened the thread; keys the Trigger Session. */
  chatId: string;
  /** The question the Start screen handed over, asked once on arrival. */
  initialQuestion?: string;
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
  });

  // `id` is what the transport keys the Session on — without it every mount
  // would open a fresh conversation under a generated id, and the chatId in
  // the URL would address nothing.
  const runtime = useChatRuntime({ id: chatId, transport });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SeedFirstQuestion runtime={runtime} question={initialQuestion} />
      <RecordChat chatId={chatId} />
      <Thread title={title} dataset={dataset} />
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
  runtime: ReturnType<typeof useChatRuntime>;
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
    void recordChat(chatId, text);
  }, [chatId, first]);

  return null;
}

function Thread({ title, dataset }: { title: string; dataset: string | null }) {
  return (
    <ThreadPrimitive.Root className={styles.chat}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <h1 className={styles.title}>{title}</h1>
          {dataset ? (
            <span className={styles.dataset}>
              <span className={styles.datasetDot} aria-hidden="true" />
              {dataset} · ClickHouse
            </span>
          ) : null}
        </div>
      </header>

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

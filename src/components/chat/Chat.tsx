"use client";

import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { clickhouseChat } from "@/trigger/chat";
import { mintChatAccessToken, startChatSession } from "@/app/actions";
import styles from "./Chat.module.css";

export function Chat({
  chatId,
  initialQuestion,
}: {
  /** Minted by whoever opened the thread; keys the Trigger Session. */
  chatId: string;
  /** The question the Start screen handed over, asked once on arrival. */
  initialQuestion?: string;
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
      <Thread />
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

function Thread() {
  return (
    <ThreadPrimitive.Root className={styles.chat}>
      <ThreadPrimitive.Viewport className={styles.messages}>
        <AuiIf condition={(s) => s.thread.messages.length === 0}>
          <p className={styles.empty}>
            Ask a question in plain language. The agent reads the schema, writes
            the SQL, and shows its work.
          </p>
        </AuiIf>

        <ThreadPrimitive.Messages>
          {({ message }) =>
            message.role === "user" ? <UserMessage /> : <AssistantMessage />
          }
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>

      <ComposerPrimitive.Root className={styles.composer}>
        {/* Renders a <textarea>, styled via `.composer textarea`. */}
        <ComposerPrimitive.Input
          rows={1}
          placeholder="Ask anything about your data…"
        />
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send className={styles.send} aria-label="Send">
            <span aria-hidden="true">↑</span>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel className={styles.send} aria-label="Stop">
            <span aria-hidden="true">■</span>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className={`${styles.message} ${styles.user}`}>
      <span className={styles.role}>You</span>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root
      className={`${styles.message} ${styles.assistant}`}
    >
      <span className={styles.role}>Vantage</span>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

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
import type { clickhouseChat } from "@/trigger/chat";
import { mintChatAccessToken, startChatSession } from "@/app/actions";
import styles from "./Chat.module.css";

export function Chat() {
  const transport = useTriggerChatTransport<typeof clickhouseChat>({
    task: "clickhouse-chat",
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) =>
      startChatSession({ chatId, clientData }),
  });

  const runtime = useChatRuntime({ transport });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
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

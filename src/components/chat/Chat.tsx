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
    <ThreadPrimitive.Root className="chat">
      <ThreadPrimitive.Viewport className="messages">
        <AuiIf condition={(s) => s.thread.messages.length === 0}>
          <p className="empty">Ask something to start the durable run.</p>
        </AuiIf>

        <ThreadPrimitive.Messages>
          {({ message }) =>
            message.role === "user" ? <UserMessage /> : <AssistantMessage />
          }
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>

      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input placeholder="Type a message..." />
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel>Stop</ComposerPrimitive.Cancel>
        </AuiIf>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message user">
      <strong>user</strong>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message assistant">
      <strong>assistant</strong>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

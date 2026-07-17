"use server";

import { auth } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";

// Creates the Session + first run, returns a session PAT. Idempotent on (env, chatId).
export const startChatSession = chat.createStartSessionAction("clickhouse-chat");

// Pure mint. The transport calls this on 401/403 to refresh an expired token.
export async function mintChatAccessToken(chatId: string) {
  return auth.createPublicToken({
    scopes: {
      read: { sessions: chatId },
      write: { sessions: chatId },
    },
    expirationTime: "1h",
  });
}

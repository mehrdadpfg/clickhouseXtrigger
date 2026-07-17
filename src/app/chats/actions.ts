"use server";

import { revalidatePath } from "next/cache";
import { createChat, getChat, touchChat } from "@/lib/db/chats";

/** Sidebar titles are one line — a question longer than this is clipped to it. */
const TITLE_MAX = 80;

function toTitle(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean;
}

/**
 * Puts the chat in the sidebar, on the first message.
 *
 * The Start screen mints a chat id and navigates; nothing writes it down. The
 * row is created here rather than when the thread page renders, because that
 * render is a GET — opening a link, or a prefetch, would otherwise create a
 * chat that was never asked anything.
 *
 * Only the list metadata is written. The messages themselves live in the
 * Trigger session, keyed by the same id (see ARCHITECTURE, "Two datastores").
 */
export async function recordChat(chatId: string, question: string) {
  const title = toTitle(question);
  if (!title) return;

  try {
    // Two turns in one thread reach this once (the caller fires on the first
    // user message only), but a double-submit or a re-mount could race it.
    if (await getChat(chatId)) {
      await touchChat(chatId);
    } else {
      try {
        await createChat({ id: chatId, title });
      } catch {
        // Lost the insert race — the row exists, which is all we wanted.
        await touchChat(chatId);
      }
    }

    // The sidebar is rendered by the /chats layout, so the layout is what has
    // to be rebuilt — revalidating the page alone leaves the list stale.
    revalidatePath("/chats", "layout");
  } catch (cause) {
    // A chat that isn't listed is a worse thread than one that is, but it is
    // still a working thread: never take the conversation down over the index.
    console.error("Could not record chat", chatId, cause);
  }
}

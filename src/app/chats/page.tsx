import { redirect } from "next/navigation";

/**
 * "/chats" no longer has a blank landing state — the chat list is a modal, and
 * threads live at "/chats/:id". Nothing links here any more; a stray visit lands
 * on the new-chat start screen instead of an empty middle column.
 */
export default function ChatsIndex() {
  redirect("/");
}

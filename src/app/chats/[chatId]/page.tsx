import { Chat } from "@/components/chat/Chat";

/**
 * "/chats/:id" — the thread.
 *
 * Thin by design: the conversation lives in Trigger.dev, keyed by the chatId in
 * the URL, so there is nothing to load server-side. The route's whole job is to
 * hand that id — and the question the Start screen minted it for — to <Chat />.
 */
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

  return <Chat chatId={chatId} initialQuestion={question || undefined} />;
}

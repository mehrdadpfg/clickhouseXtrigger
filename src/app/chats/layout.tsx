import type { ReactNode } from "react";

/**
 * The frame "/chats/:id" renders inside.
 *
 * There is no history sidebar any more — the chat list is a modal opened from
 * the rail (see ChatSwitcher) — so this is a thin passthrough. It stays a
 * segment layout only to hold `force-dynamic`: the thread page introspects the
 * live ClickHouse schema at request time, which must never be statically cached.
 */
export const dynamic = "force-dynamic";

export default function ChatsLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

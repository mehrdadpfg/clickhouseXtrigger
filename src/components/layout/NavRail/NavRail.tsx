"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { SquarePen } from "lucide-react";
import { ChatSwitcher } from "@/components/chat/ChatSwitcher";
import { cn } from "@/lib/utils";

type RailItem = {
  href: string;
  /** Glyph from the design. Decorative — the title (tooltip) carries meaning. */
  icon: string;
  /** Tooltip + accessible name, now that the visible label is gone. */
  title: string;
};

// Chats is no longer a route (the list is a modal, opened below), so it is not
// in this list — only the sections that are real pages are.
const ITEMS: readonly RailItem[] = [
  { href: "/explore", icon: "◈", title: "Explore" },
  { href: "/watch", icon: "◉", title: "Watchers" },
  { href: "/boards", icon: "▦", title: "Dashboards" },
  { href: "/tune", icon: "↯", title: "Optimize" },
];

/**
 * A rail entry: a bare icon, no circle and no label. It sits light on the black
 * canvas (text-secondary) and goes full white on hover; the active route stays
 * white. No border/background in any state — nothing to draw a pill.
 */
const RAIL_ITEM =
  "flex h-11 w-11 flex-shrink-0 cursor-pointer items-center justify-center rounded-[var(--r-md)] bg-transparent text-[19px] leading-none text-[var(--text-secondary)] no-underline transition-colors hover:text-white aria-[current=page]:text-white";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]";

/** "/watch" is active on "/watch" and "/watch/anything", not on "/watchlist". */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavRail() {
  const pathname = usePathname();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  return (
    <nav
      aria-label="Primary"
      // Sits flush on the page --bg with no divider — it reads as part of the
      // canvas. Extra top padding drops the icons off the very top edge. dvh so
      // a collapsing mobile URL bar doesn't push the rail past the fold.
      className="sticky top-0 flex h-[100dvh] w-[var(--rail-w)] flex-shrink-0 flex-col items-center gap-2 bg-[var(--bg)] pt-[30px] pb-[13px]"
    >
      {/* Compose (new chat): a plain white icon, no circle — the brightest mark
          on the rail, since it is the primary action. */}
      <Link
        href="/"
        title="New chat"
        className={cn(
          "mb-1 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--r-md)] leading-none text-white no-underline transition-opacity hover:opacity-70",
          FOCUS_RING,
        )}
      >
        <SquarePen size={20} strokeWidth={1.75} aria-hidden="true" />
        <span className="sr-only">New chat</span>
      </Link>

      {/* Chats opens the switcher modal rather than navigating — there is no
          chat-list page any more, the list lives in the overlay. */}
      <button
        type="button"
        title="Chats"
        onClick={() => setSwitcherOpen(true)}
        className={cn(RAIL_ITEM, FOCUS_RING)}
      >
        <span aria-hidden="true">▤</span>
        <span className="sr-only">Chats</span>
      </button>

      {ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          title={item.title}
          aria-current={isActive(pathname, item.href) ? "page" : undefined}
          className={cn(RAIL_ITEM, FOCUS_RING)}
        >
          <span aria-hidden="true">{item.icon}</span>
          <span className="sr-only">{item.title}</span>
        </Link>
      ))}

      <ChatSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </nav>
  );
}

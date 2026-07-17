"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { SquarePen } from "lucide-react";
import { ChatSwitcher } from "@/components/chat/ChatSwitcher";
import { cn } from "@/lib/utils";

type RailItem = {
  href: string;
  /** Glyph from the design. Decorative — the label carries the meaning. */
  icon: string;
  label: string;
  /** Tooltip. Longer than the label where the design named it differently. */
  title: string;
};

// Chats is no longer a route (the list is a modal, opened below), so it is not
// in this list — only the sections that are real pages are.
const ITEMS: readonly RailItem[] = [
  { href: "/watch", icon: "◉", label: "Watch", title: "Watchers" },
  { href: "/boards", icon: "▦", label: "Boards", title: "Dashboards" },
  { href: "/tune", icon: "↯", label: "Tune", title: "Optimize" },
];

/** Shared chrome for a rail entry — a stacked glyph over an 8.5px label. */
const RAIL_ITEM =
  "flex w-11 flex-shrink-0 cursor-pointer flex-col items-center gap-[3px] rounded-full border border-transparent bg-transparent pt-[7px] pb-[5px] text-[var(--text-muted)] no-underline hover:border-[var(--border-strong)] hover:text-foreground";

/**
 * The one place accent teal is still allowed on chrome — the focus ring
 * (alongside minor icons and the active-nav marker).
 */
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
      // Geometry (60/30/40/44px, the 13px block padding, the 5px gap) is
      // measured from the design; the rail sits on the darker --bg-rail tier.
      // dvh so a collapsing mobile URL bar doesn't push the rail past the fold.
      // Sits on the page --bg (not the darker rail tier) — only the right border
      // separates it from the content.
      className="sticky top-0 flex h-[100dvh] w-[var(--rail-w)] flex-shrink-0 flex-col items-center gap-[5px] border-r border-border bg-[var(--bg)] py-[13px]"
    >
      <Link
        href="/"
        title="New chat"
        // Pill chrome on the neutral raised tier; the compose glyph (a note with
        // a pen) stays a minor teal icon (accent is demoted to icons/links/nav).
        className={cn(
          "mb-1 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-[var(--border-accent)] bg-[var(--accent-bg)] leading-none text-brand no-underline hover:border-[var(--border-strong)] hover:text-foreground",
          FOCUS_RING,
        )}
      >
        <SquarePen size={17} strokeWidth={1.75} aria-hidden="true" />
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
        <span aria-hidden="true" className="text-[15px] leading-none">
          ▤
        </span>
        <span className="text-[8.5px] leading-none tracking-[0.02em]">
          Chats
        </span>
      </button>

      {ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          title={item.title}
          aria-current={isActive(pathname, item.href) ? "page" : undefined}
          // The design says border:none, but its hover tints a border. A
          // transparent border keeps hover from shifting the pill by a pixel.
          // aria-current is the state — no second source of truth: the active
          // route raises onto the neutral accent-bg tier with a teal glyph.
          className={cn(
            RAIL_ITEM,
            "aria-[current=page]:border-[var(--border-accent)] aria-[current=page]:bg-[var(--accent-bg)] aria-[current=page]:text-brand",
            FOCUS_RING,
          )}
        >
          <span aria-hidden="true" className="text-[15px] leading-none">
            {item.icon}
          </span>
          <span className="text-[8.5px] leading-none tracking-[0.02em]">
            {item.label}
          </span>
        </Link>
      ))}

      <ChatSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
      />
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type RailItem = {
  href: string;
  /** Glyph from the design. Decorative — the label carries the meaning. */
  icon: string;
  label: string;
  /** Tooltip. Longer than the label where the design named it differently. */
  title: string;
};

const ITEMS: readonly RailItem[] = [
  { href: "/chats", icon: "▤", label: "Chats", title: "Chats" },
  { href: "/watch", icon: "◉", label: "Watch", title: "Watchers" },
  { href: "/boards", icon: "▦", label: "Boards", title: "Dashboards" },
  { href: "/tune", icon: "↯", label: "Tune", title: "Optimize" },
];

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

  return (
    <nav
      aria-label="Primary"
      // Geometry (60/30/40/44px, the 13px block padding, the 5px gap) is
      // measured from the design; the rail sits on the darker --bg-rail tier.
      // dvh so a collapsing mobile URL bar doesn't push the rail past the fold.
      className="sticky top-0 flex h-[100dvh] w-[var(--rail-w)] flex-shrink-0 flex-col items-center gap-[5px] border-r border-border bg-[var(--bg-rail)] py-[13px]"
    >
      {/* Brand mark. Not a link — the rail's own "New chat" is the primary
          action. A rounded tile (not chrome), so it keeps a soft square. */}
      <span
        aria-hidden="true"
        className="mb-1.5 flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--border-strong)] bg-[var(--raised)] text-sm leading-none text-brand"
      >
        ◈
      </span>

      <Link
        href="/"
        title="New chat"
        // Pill chrome on the neutral raised tier; the "＋" stays a minor teal
        // icon (accent is demoted to icons/links/active-nav only).
        className={cn(
          "mb-1 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-[var(--border-accent)] bg-[var(--accent-bg)] text-[17px] leading-none text-brand no-underline hover:border-[var(--border-strong)] hover:text-foreground",
          FOCUS_RING,
        )}
      >
        <span aria-hidden="true">＋</span>
        <span className="sr-only">New chat</span>
      </Link>

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
            "flex w-11 flex-shrink-0 cursor-pointer flex-col items-center gap-[3px] rounded-full border border-transparent bg-transparent pt-[7px] pb-[5px] text-[var(--text-muted)] no-underline hover:border-[var(--border-strong)] hover:text-foreground",
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
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./NavRail.module.css";

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

/** "/watch" is active on "/watch" and "/watch/anything", not on "/watchlist". */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavRail() {
  const pathname = usePathname();

  return (
    <nav className={styles.rail} aria-label="Primary">
      <span className={styles.mark} aria-hidden="true">
        ◈
      </span>

      <Link href="/" className={styles.newChat} title="New chat">
        <span aria-hidden="true">＋</span>
        <span className="sr-only">New chat</span>
      </Link>

      {ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={styles.item}
          title={item.title}
          aria-current={isActive(pathname, item.href) ? "page" : undefined}
        >
          <span className={styles.icon} aria-hidden="true">
            {item.icon}
          </span>
          <span className={styles.label}>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}

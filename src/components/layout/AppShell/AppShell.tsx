import type { ReactNode } from "react";
import { NavRail } from "../NavRail/NavRail";
import styles from "./AppShell.module.css";

/**
 * The frame every route renders inside: the persistent rail plus a slot for
 * page content. Server component — it holds no state, so pages stay free to be
 * RSCs themselves.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <NavRail />
      <div className={styles.content}>{children}</div>
    </div>
  );
}

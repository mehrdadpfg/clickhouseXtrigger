import type { ReactNode } from "react";
import { NavRail } from "../NavRail/NavRail";

/**
 * The frame every route renders inside: the persistent rail plus a slot for
 * page content. Server component — it holds no state, so pages stay free to be
 * RSCs themselves.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh]">
      <NavRail />
      {/* min-w-0 so a wide table or chart inside a page scrolls itself instead
          of stretching the flex row and pushing the rail off-screen. */}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

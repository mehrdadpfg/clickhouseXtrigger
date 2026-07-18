import type { ReactNode } from "react";

/**
 * A template (unlike a layout) re-mounts on every navigation, so this wrapper's
 * enter animation replays each time the route changes — a short cross-route
 * fade. Opacity only: it never touches the box model, so full-height pages (the
 * chat thread self-bounds at 100dvh) and their scroll containers are untouched.
 * The global prefers-reduced-motion guard collapses it to an instant swap.
 */
export default function Template({ children }: { children: ReactNode }) {
  return (
    <div className="animate-[v-fade_var(--motion-base)_var(--ease-out)]">
      {children}
    </div>
  );
}

"use client";

import { useChatPrefs } from "./ChatPrefs";

/**
 * The chat's settings strip — a thin row under the composer.
 *
 * For now it carries one control: the verbose switch, which shows or hides the
 * agent's work (the tool-call card and the SQL receipt). It is the seam where
 * later chat settings land — a default notify channel for watchers born here,
 * say — so it is a labelled row, not a lone toggle.
 */
export function ChatSettings() {
  const { verbose, setVerbose } = useChatPrefs();

  return (
    <div className="flex items-center justify-end gap-2 pt-2 text-[11.5px] text-[var(--text-muted)]">
      <button
        type="button"
        role="switch"
        aria-checked={verbose}
        onClick={() => setVerbose(!verbose)}
        className="group inline-flex cursor-pointer items-center gap-2 rounded-full border-0 bg-transparent px-1 py-0.5 hover:text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        title={verbose ? "Showing the agent's steps and queries" : "Hiding steps and queries"}
      >
        <span>Show the agent&rsquo;s work</span>
        {/* A bare CSS switch — track + knob, driven by aria-checked. */}
        <span
          aria-hidden="true"
          className="relative h-[16px] w-[28px] flex-shrink-0 rounded-full border border-[var(--border-strong)] bg-[var(--raised)] transition-colors group-aria-[checked=true]:border-[var(--border-accent)] group-aria-[checked=true]:bg-[var(--accent-bg)]"
        >
          <span className="absolute top-[2px] left-[2px] h-[10px] w-[10px] rounded-full bg-[var(--text-muted)] transition-transform group-aria-[checked=true]:translate-x-[12px] group-aria-[checked=true]:bg-[var(--accent)]" />
        </span>
      </button>
    </div>
  );
}

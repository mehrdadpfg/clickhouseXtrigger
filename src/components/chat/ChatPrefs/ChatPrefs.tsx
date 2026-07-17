"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Per-reader chat display preferences.
 *
 * `verbose` decides whether the agent's work is shown: the tool-call work card
 * and the SQL receipt. On (the default) shows everything — the "show your work"
 * stance the product is built on. Off gives a cleaner, answer-first thread.
 *
 * It is a client preference, not chat state — it lives in localStorage and rides
 * a context so every AgentTurn/Artifact in the thread reads the same value
 * without threading a prop through assistant-ui's render callbacks. This is also
 * where later per-reader chat settings (e.g. a default notify channel for
 * watchers born here) will hang.
 */
interface ChatPrefs {
  verbose: boolean;
  setVerbose: (next: boolean) => void;
}

const ChatPrefsContext = createContext<ChatPrefs | null>(null);

const STORAGE_KEY = "vantage.chat.verbose";

export function ChatPrefsProvider({ children }: { children: ReactNode }) {
  const [verbose, setVerboseState] = useState(true);

  // Read the stored preference after mount, so the server and first client
  // render agree (both default to verbose) and there is no hydration mismatch.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null) setVerboseState(stored === "1");
    } catch {
      // localStorage can throw (privacy mode); the default stands.
    }
  }, []);

  const value = useMemo<ChatPrefs>(
    () => ({
      verbose,
      setVerbose: (next) => {
        setVerboseState(next);
        try {
          window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
        } catch {
          // Non-fatal — the choice just won't survive a reload.
        }
      },
    }),
    [verbose],
  );

  return (
    <ChatPrefsContext.Provider value={value}>
      {children}
    </ChatPrefsContext.Provider>
  );
}

/**
 * Read the chat prefs. Returns the verbose default outside a provider, so a
 * component that renders without one (a test, a stray mount) still behaves.
 */
export function useChatPrefs(): ChatPrefs {
  return (
    useContext(ChatPrefsContext) ?? {
      verbose: true,
      setVerbose: () => {},
    }
  );
}

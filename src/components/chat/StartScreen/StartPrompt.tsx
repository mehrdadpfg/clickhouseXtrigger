"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Starter } from "./schema";
import styles from "./StartScreen.module.css";

/**
 * The two ways to leave the Start screen: type a question, or take one of the
 * suggested starters. Both do the same thing — mint a chat id and hand the
 * question to the thread — but they live in different parts of the screen now
 * (the input is the focus, up top; the starters sit below), so they're two
 * components sharing this one navigation.
 *
 * The id is minted client-side rather than on the server so a back-navigation
 * or a cached render can't drop two conversations into the same thread.
 */
function useAsk(disabled: boolean) {
  const router = useRouter();
  return (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    router.push(`/chats/${crypto.randomUUID()}?q=${encodeURIComponent(trimmed)}`);
  };
}

export function PromptInput({
  placeholder,
  disabled = false,
}: {
  placeholder: string;
  /** No dataset connected — there is nothing to ask about. */
  disabled?: boolean;
}) {
  const ask = useAsk(disabled);
  const [question, setQuestion] = useState("");

  return (
    <form
      className={styles.composer}
      onSubmit={(e) => {
        e.preventDefault();
        ask(question);
      }}
    >
      <input
        className={styles.input}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-label="Ask a question about your data"
        autoComplete="off"
      />
      <button
        type="submit"
        className={styles.send}
        disabled={disabled || question.trim() === ""}
      >
        <span aria-hidden="true">↑</span>
        <span className="sr-only">Ask</span>
      </button>
    </form>
  );
}

export function Starters({
  starters,
  disabled = false,
}: {
  starters: Starter[];
  disabled?: boolean;
}) {
  const ask = useAsk(disabled);

  return (
    <div className={styles.starters}>
      {starters.map((starter) => (
        <button
          key={starter.question}
          type="button"
          className={styles.starter}
          disabled={disabled}
          onClick={() => ask(starter.question)}
        >
          <span className={styles.starterTitle}>{starter.question}</span>
          <span
            className={`${styles.starterHint} ${
              starter.watcher ? styles.starterWatcher : ""
            }`}
          >
            {starter.hint}
          </span>
        </button>
      ))}
    </div>
  );
}

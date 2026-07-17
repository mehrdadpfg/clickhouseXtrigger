"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Starter } from "./schema";
import styles from "./StartScreen.module.css";

/**
 * The two ways to leave the Start screen: type a question, or take one of the
 * four the schema suggested. Both do the same thing — mint a chat id and hand
 * the question to the thread.
 *
 * Client, and deliberately the only client island on the screen: everything
 * else the Start screen shows is introspected server-side and static by the
 * time it reaches the browser.
 */
export function StartPrompt({
  starters,
  placeholder,
  disabled = false,
}: {
  starters: Starter[];
  placeholder: string;
  /** No dataset connected — there is nothing to ask about. */
  disabled?: boolean;
}) {
  const router = useRouter();
  const [question, setQuestion] = useState("");

  /**
   * The id is minted here rather than server-side so a back-navigation or a
   * cached render can't drop two conversations into the same thread.
   */
  function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    router.push(
      `/chats/${crypto.randomUUID()}?q=${encodeURIComponent(trimmed)}`,
    );
  }

  return (
    <>
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

      <div className={styles.eyebrow}>Try starting with</div>
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
    </>
  );
}

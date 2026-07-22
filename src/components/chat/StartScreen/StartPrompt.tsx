"use client";

import { useRouter } from "next/navigation";
import { useState, type ComponentType } from "react";
import {
  Database,
  Gauge,
  LayoutDashboard,
  Lightbulb,
  MessagesSquare,
  Sparkles,
  Telescope,
  TrendingUp,
  Workflow,
} from "lucide-react";
import type { Starter } from "./schema";
import styles from "./StartScreen.module.css";
import { TableMention } from "../TableMention";

type LucideIcon = ComponentType<{ size?: number; strokeWidth?: number }>;

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
    <TableMention value={question} onChange={setQuestion}>
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
    </TableMention>
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

type ChipPrompt = { text: string; icon: LucideIcon };
type ChipGroup = { key: string; label: string; icon: LucideIcon; prompts: ChipPrompt[] };

/**
 * The chips under the composer and the prompts each reveals.
 *
 * Deliberately NOT schema-derived: they name no column, so they survive the data
 * changing or a different table being connected — the agent introspects the live
 * schema when a prompt runs. Standing, table-agnostic asks.
 */
const CHIP_GROUPS: ChipGroup[] = [
  {
    key: "explore",
    label: "Explore your data",
    icon: Telescope,
    prompts: [
      // "What's worth noticing" is the discovery/explorer flow, named — asked in
      // chat it runs the same surface-the-surprises analysis inline.
      { text: "What's worth noticing?", icon: Sparkles },
      { text: "What data is available?", icon: Database },
      { text: "Suggest good starter questions", icon: Lightbulb },
      { text: "Interview me about my goals", icon: MessagesSquare },
      { text: "Diagram my data model", icon: Workflow },
    ],
  },
  {
    key: "artifact",
    label: "Create an Artifact",
    icon: LayoutDashboard,
    prompts: [
      { text: "Build a dashboard overview", icon: LayoutDashboard },
      { text: "Chart the most important trend over time", icon: TrendingUp },
      { text: "Summarize the key metrics as KPI tiles", icon: Gauge },
    ],
  },
];

/**
 * The chip row under the composer. Each chip drops down its prompts, each a click
 * away from a chat; opening one closes the other. This is the entry the removed
 * Explore nav tab used to be — surfaced on the Start screen where the reader
 * already is, not a separate route.
 */
export function StartExplore({ disabled = false }: { disabled?: boolean }) {
  const ask = useAsk(disabled);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const active = CHIP_GROUPS.find((g) => g.key === openKey) ?? null;

  return (
    <div className={styles.exploreBlock}>
      <div className={styles.chipRow}>
        {CHIP_GROUPS.map((group) => {
          const Icon = group.icon;
          const isOpen = group.key === openKey;
          return (
            <button
              key={group.key}
              type="button"
              className={`${styles.chip} ${isOpen ? styles.chipActive : ""}`}
              disabled={disabled}
              aria-expanded={isOpen}
              onClick={() => setOpenKey(isOpen ? null : group.key)}
            >
              <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
              {group.label}
            </button>
          );
        })}
      </div>

      {active ? (
        <ul className={styles.starterList}>
          {active.prompts.map((prompt) => {
            const Icon = prompt.icon;
            return (
              <li key={prompt.text}>
                <button
                  type="button"
                  className={styles.starterRow}
                  disabled={disabled}
                  onClick={() => ask(prompt.text)}
                >
                  <Icon size={16} strokeWidth={1.6} aria-hidden="true" />
                  <span className={styles.starterRowText}>{prompt.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

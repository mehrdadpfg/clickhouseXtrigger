"use client";

import type { ReactNode } from "react";
import {
  AuiIf,
  groupPartByType,
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { Card, Spinner } from "@/components/ui";
import { useChatPrefs } from "../ChatPrefs";
import { AnswerActions } from "./AnswerActions";
import { Artifacts } from "./Artifacts";
import { phaseLabel, stepCopy } from "./steps";
import styles from "./AgentTurn.module.css";
import { Markdown } from "@/components/ui";

/**
 * Vantage.dc.html: the agent turn — a card of what it is doing, the answer,
 * then the artifacts and the action bar.
 *
 * Adjacent tool calls are coalesced into one "work" card by GroupedParts, which
 * is what the design draws: not one spinner per call, but a single card whose
 * rows tick over from running to done.
 */
export function AgentTurn() {
  // Verbose off hides the agent's work — the tool-call card and its steps — for
  // an answer-first thread. The SQL receipt is hidden in Artifacts the same way.
  const { verbose } = useChatPrefs();
  return (
    <MessagePrimitive.Root className={styles.turn}>
      <div className={styles.body}>
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({ "tool-call": ["group-work"] })}
          indicator="no-text"
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-work":
                return verbose ? (
                  <WorkCard
                    running={part.status.type === "running"}
                    indices={part.indices}
                  >
                    {children}
                  </WorkCard>
                ) : null;

              case "tool-call":
                return verbose ? (
                  <Step
                    toolName={part.toolName}
                    args={part.args}
                    running={part.status.type === "running"}
                    failed={part.isError === true}
                  />
                ) : null;

              case "text":
                // Only render inline text when the WORK is shown — the agent
                // narrates its plan between tool calls ("Now let's get the time
                // range…"), which is fine alongside the steps but reads as a
                // jumbled answer once the work is hidden. With work hidden, the
                // clean caption is rendered by <FinalAnswer/> below instead.
                // (An empty text part is the runtime reserving a slot before the
                // first token; rendering it would open a blank paragraph.)
                return verbose && part.text ? (
                  <Markdown className={styles.answer}>{part.text}</Markdown>
                ) : null;

              // Running, with nothing to show yet — the only honest moment for
              // a bare spinner, and it says which way it is facing.
              case "indicator":
                return (
                  <p className={styles.thinking}>
                    <Spinner size="md" /> Reading your question…
                  </p>
                );

              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>

        {/* Work hidden: render only the clean final caption, not the agent's
            between-step planning text (which GroupedParts suppressed above). */}
        {verbose ? null : <FinalAnswer />}

        {/* Both gate on the answer being finished — see Artifacts for why. */}
        <AuiIf condition={isAnswerComplete}>
          <Artifacts />
        </AuiIf>
        <AuiIf condition={isAnswerComplete}>
          <AnswerActions />
        </AuiIf>
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * The clean answer, shown when the agent's work is hidden.
 *
 * With work shown, every text part renders inline — including the plan the agent
 * narrates between tool calls. With work hidden those interleaved fragments read
 * as one incoherent answer, so here we render ONLY the text that follows the
 * LAST tool call (the real caption) and drop the process narration. When there
 * were no tools, that's the whole answer.
 */
function FinalAnswer() {
  const answer = useAuiState((s) => {
    const parts = s.message.parts;
    let lastTool = -1;
    parts.forEach((p, i) => {
      const t = (p as { type?: string }).type ?? "";
      if (t.startsWith("tool-") || t === "dynamic-tool") lastTool = i;
    });
    const texts: string[] = [];
    parts.forEach((p, i) => {
      if (i <= lastTool) return;
      const rec = p as { type?: string; text?: string };
      if (rec.type === "text" && rec.text) texts.push(rec.text);
    });
    return texts.join("\n\n").trim();
  });
  return answer ? <Markdown className={styles.answer}>{answer}</Markdown> : null;
}

/**
 * A user message has no `status`, so the property is checked before it is read
 * — this selector runs against whichever message is in scope.
 */
function isAnswerComplete(state: {
  message: { status?: { type: string } };
}): boolean {
  return state.message.status?.type === "complete";
}

/** The design's working card: a phase header over a list of steps. */
function WorkCard({
  running,
  indices,
  children,
}: {
  running: boolean;
  indices: readonly number[];
  children: ReactNode;
}) {
  const parts = useAuiState((s) => s.message.parts);

  // The header names the phase the agent is in right now, which is the last
  // step it started — "Reading schema · sales.orders", not "Working…".
  const last = indices.length > 0 ? parts[indices[indices.length - 1]!] : undefined;
  const header =
    running && last?.type === "tool-call"
      ? phaseLabel(last.toolName, last.args)
      : running
        ? "Working"
        : `Did the work · ${indices.length} step${indices.length === 1 ? "" : "s"}`;

  return (
    <Card className={styles.workCard}>
      <div className={styles.workHead}>
        {running ? (
          <Spinner size="md" />
        ) : (
          <span className={styles.done} aria-hidden="true">
            ✓
          </span>
        )}
        <span className={styles.phase}>{header}</span>
      </div>
      <div className={styles.steps}>{children}</div>
    </Card>
  );
}

/** One tool call, as a line of prose about what it did. */
function Step({
  toolName,
  args,
  running,
  failed,
}: {
  toolName: string;
  args: unknown;
  running: boolean;
  failed: boolean;
}) {
  const { label, detail } = stepCopy(toolName, args, running);

  return (
    <div className={styles.step}>
      {running ? (
        <Spinner size="sm" />
      ) : (
        <span
          className={failed ? styles.failed : styles.done}
          aria-hidden="true"
        >
          {failed ? "✕" : "✓"}
        </span>
      )}
      <span className={running ? styles.stepLive : undefined}>{label}</span>
      {detail ? <span className={styles.detail}>{detail}</span> : null}
      {failed ? <span className={styles.failedNote}>failed</span> : null}
    </div>
  );
}

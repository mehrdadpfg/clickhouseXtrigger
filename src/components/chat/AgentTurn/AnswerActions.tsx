"use client";

import { useId } from "react";
import { Button } from "@/components/ui";
import styles from "./AgentTurn.module.css";

/**
 * The bar under a finished answer: Fork, and Promote to watcher.
 *
 * Both are wired to nothing yet — the behaviour lands in later phases. They are
 * therefore `disabled` *and* carry a reason rendered as visible text, not a
 * title tooltip: a control that looks live and does nothing on click teaches
 * the reader the app is broken, and a tooltip-only explanation is invisible to
 * touch and to a screen reader that never hovers.
 *
 * aria-describedby ties the reason to the buttons, so the explanation is read
 * out with the (disabled) control rather than orphaned beside it.
 */
export function AnswerActions() {
  const reasonId = useId();

  return (
    <div className={styles.actions}>
      <Button size="sm" icon="⑃" disabled aria-describedby={reasonId}>
        Fork
      </Button>

      <Button
        size="sm"
        variant="primary"
        icon="◉"
        disabled
        aria-describedby={reasonId}
      >
        Promote to watcher
      </Button>

      <span id={reasonId} className={styles.reason}>
        Forking and watchers arrive in a later phase.
      </span>
    </div>
  );
}

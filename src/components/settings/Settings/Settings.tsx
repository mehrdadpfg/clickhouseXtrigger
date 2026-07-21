"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import type { ActionResult } from "@/components/watch/model";
import styles from "./Settings.module.css";

/**
 * The Settings screen.
 *
 * One control today — the global default notification email, the fallback
 * recipient for any watcher that names no address of its own. A labelled section
 * rather than a lone input, so later settings land beside it the way the chat's
 * settings strip is built to grow.
 *
 * A client island: the form holds its own draft and reports save state inline.
 * The route passes the persisted value and the save action in, so this component
 * never imports lib/db — the same app -> components -> lib discipline the rest of
 * the app keeps.
 */
export function Settings({
  defaultEmail,
  onSave,
  error,
}: {
  /** The persisted global default, or "" when none is set. */
  defaultEmail: string;
  onSave: (email: string) => Promise<ActionResult>;
  /** Postgres did not answer. A state to render, not a 500. */
  error?: string;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startSave] = useTransition();

  // The field is "dirty" once it diverges from what is stored, so Save is only
  // live when there is a change to make — and the "Saved" note clears the moment
  // the author edits again.
  const dirty = email.trim() !== defaultEmail.trim();

  const save = () => {
    setSaveError(null);
    setSaved(false);
    startSave(async () => {
      const result = await onSave(email.trim());
      if (result.ok) setSaved(true);
      else setSaveError(result.error);
    });
  };

  return (
    <main className={styles.page}>
      <div className={styles.column}>
        <header className={styles.head}>
          <h1 className={styles.title}>Settings</h1>
          <p className={styles.lede}>
            Install-wide preferences. These apply everywhere — every chat, every
            board, every watcher.
          </p>
        </header>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <section className={styles.section}>
          <h2 className={styles.eyebrow}>Alerts</h2>

          <div className={styles.card}>
            <label className={styles.field} htmlFor="default-notify-email">
              <span className={styles.fieldLabel}>Default notification email</span>
              <span className={styles.fieldHint}>
                Where a watcher&rsquo;s alert is emailed when it sets no address of
                its own. Leave blank to turn email alerts off by default.
              </span>
              <input
                id="default-notify-email"
                className={styles.input}
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setSaved(false);
                  setSaveError(null);
                }}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </label>

            <div className={styles.actionRow}>
              {saveError ? (
                <p className={styles.error} role="alert">
                  {saveError}
                </p>
              ) : saved && !dirty ? (
                <p className={styles.saved} role="status">
                  Saved.
                </p>
              ) : (
                <span />
              )}
              <Button
                variant="primary"
                onClick={save}
                disabled={pending || !dirty}
              >
                {pending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

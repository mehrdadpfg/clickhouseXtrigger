"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";
import type { AlertView, WatchActions } from "../model";

/**
 * Recent alerts — what tripped, when, and from which question.
 *
 * The design showed three tones (⚠ / ▲ / ✓, the last being "recovered"). The
 * schema has no severity column and no recovery event: an alert row *is* a
 * threshold trip, full stop. So tone here encodes the one real distinction the
 * data carries — `acknowledged`. Unread trips are critical and bright; read
 * ones go quiet. That reproduces the design's one-bright-card-then-dimmer
 * rhythm without inventing a severity nobody stored.
 */
export function AlertsFeed({
  alerts,
  actions,
}: {
  alerts: AlertView[];
  actions: WatchActions;
}) {
  if (alerts.length === 0) {
    return (
      <p className="m-0 px-0.5 py-5 text-[13px] text-muted-foreground">
        Nothing has tripped yet. Alerts land here when a watcher crosses its
        threshold.
      </p>
    );
  }

  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 min-[620px]:grid-cols-2 min-[900px]:grid-cols-3">
      {alerts.map((alert) => (
        <AlertCard key={alert.id} alert={alert} actions={actions} />
      ))}
    </ul>
  );
}

function AlertCard({
  alert,
  actions,
}: {
  alert: AlertView;
  actions: WatchActions;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const unread = !alert.acknowledged;

  function acknowledge() {
    startTransition(async () => {
      const result = await actions.acknowledge(alert.id);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <li>
      {/* Card carries the flat surface; `critical` tone borders an unread trip
          red, matching the design's bright-then-quiet rhythm. */}
      <Card
        tone={unread ? "critical" : "neutral"}
        padding="sm"
        // The Card is a <li> child, so it fills the grid cell.
        className="h-full"
      >
        <div className="flex items-center gap-2">
          {/* Redundant with the colour, on purpose — status is never carried by
              colour alone. */}
          <span
            className={cn(
              "shrink-0 text-[12px] leading-none",
              unread ? "text-[var(--critical)]" : "text-[var(--good)]",
            )}
            aria-hidden="true"
          >
            {unread ? "⚠" : "✓"}
          </span>
          <span
            className={cn(
              "min-w-0 text-[13px] [overflow-wrap:anywhere]",
              unread ? "text-[var(--text)]" : "text-[var(--text-secondary)]",
            )}
          >
            {alert.message}
          </span>
          <span className="sr-only">{unread ? " (unread)" : " (read)"}</span>

          {alert.chatId ? (
            <Link
              href={`/chats/${alert.chatId}`}
              className="ml-auto shrink-0 whitespace-nowrap rounded-[var(--r-sm)] text-[11.5px] text-brand no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              jump <span aria-hidden="true">→</span>
              <span className="sr-only"> to {alert.source}</span>
            </Link>
          ) : null}
        </div>

        <div className="tnum mt-[5px] flex min-w-0 items-center gap-2.5 pl-5 font-mono text-[10.5px] text-muted-foreground">
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {alert.stamp} · {alert.source}
          </span>
          {unread ? (
            <button
              type="button"
              className="ml-auto shrink-0 cursor-pointer rounded-full border border-border px-[7px] py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-[var(--border-strong)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)] disabled:cursor-default disabled:opacity-50"
              onClick={acknowledge}
              disabled={pending}
            >
              mark read
            </button>
          ) : null}
        </div>

        {error ? (
          <p className="mt-1.5 text-[11px] text-[var(--critical)]" role="alert">
            {error}
          </p>
        ) : null}
      </Card>
    </li>
  );
}

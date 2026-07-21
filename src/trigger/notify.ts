/**
 * watcher-notify — email a watcher's alert, off the critical path of the tick.
 *
 * WHY A SEPARATE TASK, NOT INLINE IN THE TICK
 * -------------------------------------------
 * The tick's job is to measure and record: read the SQL, compare the threshold,
 * write last_value/is_firing, log the alert. Sending mail is I/O on a third-
 * party API that can be slow, rate-limited, or down. Doing it inline would let a
 * Resend hiccup delay or fail a run whose real work — the reading — already
 * succeeded and is already saved. So the tick fire-and-forgets THIS task
 * (`.trigger`, not `.triggerAndWait`): the reading is committed regardless, and
 * the email gets its own run, its own retries, and its own place in the
 * dashboard when it fails.
 *
 * Idempotency is the tick's concern, not this task's: the tick only triggers a
 * notify on the FIRING transition (!wasFiring && isFiring), so a watcher that
 * stays firing for a week mails once, not every five minutes.
 */
import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/notify/resend";

// The same reading formatter the tick and the Watch page use, kept local so the
// email's presentation lives with the email. '$' leads and pads to two digits;
// '%' and '×' trail; a bare number is grouped. Mirrors formatReading in
// trigger/watchers and components/watch/model.
function formatReading(value: number, unit?: string): string {
  const n = value.toLocaleString("en-US", {
    minimumFractionDigits: unit === "$" ? 2 : 0,
    maximumFractionDigits: 2,
  });
  if (!unit) return n;
  return unit === "$" ? `$${n}` : `${n}${unit}`;
}

const DIRECTION_VERB = {
  rises_above: "rose above",
  drops_below: "dropped below",
  changes_by: "changed by",
} as const;

export const watcherNotify = schemaTask({
  id: "watcher-notify",
  // Email is transient-failure-prone (rate limits, brief API outages) and worth
  // a few tries — but it is a courtesy on top of the on-page alert, not the
  // alert itself, so it does not deserve the tick's restraint. A handful of
  // backed-off attempts, then give up; the Watch page already shows the trip.
  retry: { maxAttempts: 4 },
  run: async (payload) => {
    const reading = formatReading(payload.value, payload.unit);
    const threshold = formatReading(payload.thresholdValue, payload.unit);
    const verb = DIRECTION_VERB[payload.direction];

    const subject = `⚠ ${payload.question} — ${reading}`;

    // The watch list is the destination: there is no per-watcher route, and the
    // list is where the firing hero and this watcher's row already live.
    const link = `${env.APP_BASE_URL}/watch`;

    const lines = [
      `${payload.question}`,
      ``,
      `Reading: ${reading}`,
      `Threshold: ${verb} ${threshold}${
        payload.direction === "changes_by" ? " (vs 4-week average)" : ""
      }`,
      `Checked: ${payload.cadence}`,
      ``,
      `Open the watcher: ${link}`,
    ];

    const html =
      `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">` +
      `<p style="margin:0 0 12px"><strong>${escapeHtml(payload.question)}</strong> tripped its threshold.</p>` +
      `<table style="border-collapse:collapse;margin:0 0 16px">` +
      row("Reading", reading) +
      row(
        "Threshold",
        `${verb} ${threshold}${payload.direction === "changes_by" ? " (vs 4-week average)" : ""}`,
      ) +
      row("Checked", payload.cadence) +
      `</table>` +
      `<p style="margin:0"><a href="${link}">Open the watcher →</a></p>` +
      `</div>`;

    const result = await sendEmail({
      to: payload.to,
      subject,
      text: lines.join("\n"),
      html,
    });

    // { sent: false } is the "not configured" no-op, already logged in the lib —
    // return it rather than throw, so a keyless install doesn't fill the
    // dashboard with failed notify runs.
    return { watcherId: payload.watcherId, ...result };
  },
  schema: z.object({
    /** Which watcher tripped — for logging and traceability, not display. */
    watcherId: z.string(),
    /** Resolved recipient (per-watcher email, or the global default). */
    to: z.string().email(),
    question: z.string(),
    value: z.number().finite(),
    thresholdValue: z.number().finite(),
    direction: z.enum(["rises_above", "drops_below", "changes_by"]),
    /** Display unit carried from the source chart ('$', '%', '×'). */
    unit: z.string().max(4).optional(),
    /** Human cadence phrase, e.g. "every 5 min". */
    cadence: z.string(),
  }),
});

function row(label: string, value: string): string {
  return (
    `<tr>` +
    `<td style="padding:2px 16px 2px 0;color:#888">${escapeHtml(label)}</td>` +
    `<td style="padding:2px 0"><strong>${escapeHtml(value)}</strong></td>` +
    `</tr>`
  );
}

/** The question and unit are user-authored; they must not break the HTML body. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

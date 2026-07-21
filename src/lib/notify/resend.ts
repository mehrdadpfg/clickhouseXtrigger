/**
 * Resend — the one place that actually puts mail on the wire.
 *
 * Everything about a watcher alert (subject, body, recipient) is decided by the
 * caller; this only sends. Two rules it keeps so nothing upstream has to:
 *
 *   * NO KEY, NO CRASH. With RESEND_API_KEY unset, sending is a logged no-op.
 *     Email is an add-on to a watcher, not a prerequisite — an install without a
 *     key still watches, alerts on the page, and simply doesn't mail. The task
 *     that calls this treats a skip as success, so it never fails a run.
 *   * ERRORS ARE RETURNED, NOT THROWN on the happy path being unavailable, but
 *     a genuine Resend API failure IS thrown so the notify task's retry can see
 *     it. The difference: "not configured" is a steady state, "the API 500ed" is
 *     transient.
 *
 * Server-only. Never import from a "use client" module.
 */
import { Resend } from "resend";
import { env } from "@/lib/env";

/**
 * One client per process, created lazily. Null when there is no key — the caller
 * reads that as "skip", not "error".
 */
let client: Resend | null | undefined;

function resend(): Resend | null {
  if (client === undefined) {
    client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
  }
  return client;
}

export type SendEmailInput = {
  to: string;
  subject: string;
  /** Plain-text body. Always sent — the reliable render in every client. */
  text: string;
  /** Optional HTML body, layered on top for clients that prefer it. */
  html?: string;
};

export type SendEmailResult =
  | { sent: true; id: string | null }
  | { sent: false; reason: "not-configured" };

/**
 * Send one email. Resolves { sent: false } when Resend isn't configured (a
 * no-op, logged once), and throws only when a configured send actually fails —
 * which is what the notify task retries on.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const api = resend();

  if (!api) {
    console.warn(
      "RESEND_API_KEY is not set — skipping watcher alert email to",
      input.to,
    );
    return { sent: false, reason: "not-configured" };
  }

  const { data, error } = await api.emails.send({
    from: env.RESEND_FROM,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
  });

  if (error) {
    // Surface the API's own message so the notify task's retry (and the Trigger
    // dashboard) show why it failed.
    throw new Error(`Resend refused the alert email: ${error.message}`);
  }

  return { sent: true, id: data?.id ?? null };
}

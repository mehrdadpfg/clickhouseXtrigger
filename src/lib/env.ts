import { z } from "zod";

/**
 * Validated, typed environment. Import from here — never read process.env
 * directly elsewhere, so a missing var fails loudly at boot with a useful
 * message instead of surfacing as `undefined` deep in a query.
 *
 * Server-only. Never import this from a "use client" module.
 */
const schema = z.object({
  /**
   * Postgres — app state: chats, watchers, alerts, boards.
   * Standard libpq vars; node-postgres also reads these natively, so we
   * validate rather than re-assemble them into a URL.
   */
  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().positive().default(5432),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  PGDATABASE: z.string().min(1),

  /** ClickHouse — the analytical data plane + system.query_log. */
  CLICKHOUSE_URL: z.string().url(),

  /** Anthropic — used by the chat.agent task. */
  ANTHROPIC_API_KEY: z.string().min(1),

  /** Trigger.dev — required by the server actions that mint session tokens. */
  TRIGGER_SECRET_KEY: z.string().min(1),

  /**
   * Resend — watcher alert emails. Optional by design: with no key, sending
   * no-ops with a logged warning rather than crashing a watcher tick, so the
   * app runs end-to-end without email configured.
   */
  RESEND_API_KEY: z.string().min(1).optional(),
  /**
   * The From address on alert emails. Defaults to Resend's zero-setup test
   * sender, which needs no verified domain — enough to see mail arrive in dev.
   */
  RESEND_FROM: z.string().min(1).default("onboarding@resend.dev"),

  /**
   * Absolute base URL for links in emails (e.g. "→ open the watcher"). A tick
   * runs in Trigger's cloud with no request to infer the host from, so it is
   * configured. Defaults to local dev.
   */
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
});

function load() {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment.\n${missing}\n\nCopy .env.example to .env and fill it in.`,
    );
  }

  return parsed.data;
}

export const env = load();

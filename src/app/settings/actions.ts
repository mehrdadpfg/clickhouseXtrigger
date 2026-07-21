"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { setDefaultNotifyEmail } from "@/lib/db/settings";
import type { ActionResult } from "@/components/watch/model";

/**
 * The Settings page's one write: the global default alert recipient.
 *
 * A server action is a public endpoint with a nice call site — the value arrives
 * from the network, so it is parsed here before it reaches the store. An empty
 * string is a valid input: it clears the default (notifications off for any
 * watcher without its own address), so it is allowed alongside a real email.
 */
const Email = z
  .union([z.literal(""), z.string().trim().email().max(200)])
  .transform((v) => (v ? v : null));

export async function setDefaultNotifyEmailAction(
  email: unknown,
): Promise<ActionResult> {
  const parsed = Email.safeParse(email);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "That is not a valid email.",
    };
  }

  try {
    await setDefaultNotifyEmail(parsed.data);
    revalidatePath("/settings");
    // The watcher editor's placeholder reads this default; keep /watch honest too.
    revalidatePath("/watch");
    return { ok: true };
  } catch (cause) {
    console.error("Could not save the default notify email", cause);
    return {
      ok: false,
      error:
        cause instanceof Error ? cause.message : "Something went wrong. Try again.",
    };
  }
}

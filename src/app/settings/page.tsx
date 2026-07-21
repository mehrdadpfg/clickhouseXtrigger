import { Settings } from "@/components/settings";
import { getDefaultNotifyEmail } from "@/lib/db/settings";
import { setDefaultNotifyEmailAction } from "./actions";

/**
 * "/settings" — install-wide preferences.
 *
 * An RSC: the current global default notification email is read at request time
 * and handed to the client form, along with the one server action that persists
 * it. The action is passed as a prop rather than imported by the component, so
 * dependencies stay app -> components -> lib and lib/db never ships to a browser
 * — the same discipline as the Watch and Boards pages.
 */
export const dynamic = "force-dynamic";

async function load(): Promise<{ defaultEmail: string; error?: string }> {
  try {
    const email = await getDefaultNotifyEmail();
    return { defaultEmail: email ?? "" };
  } catch (cause) {
    console.error("Settings page load failed", cause);
    return {
      defaultEmail: "",
      error:
        cause instanceof Error
          ? `Could not reach the settings store: ${cause.message}`
          : "Could not reach the settings store.",
    };
  }
}

export default async function SettingsPage() {
  const { defaultEmail, error } = await load();

  return (
    <Settings
      defaultEmail={defaultEmail}
      onSave={setDefaultNotifyEmailAction}
      error={error}
    />
  );
}

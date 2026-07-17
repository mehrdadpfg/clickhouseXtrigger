import Link from "next/link";
import styles from "./page.module.css";

/**
 * "/chats" — the list with nothing selected.
 *
 * The list itself is the layout's sidebar, so this is only the empty middle:
 * what to do next. A chat id is minted on the Start screen, so that is where
 * "new chat" goes.
 */
export default function ChatsPage() {
  return (
    <main className={styles.empty}>
      <div className={styles.inner}>
        <span className={styles.mark} aria-hidden="true">
          ◈
        </span>
        <h1 className={styles.headline}>Pick up a thread</h1>
        <p className={styles.copy}>
          Choose a chat from the history, or ask something new — the agent reads
          the schema, writes the SQL, and shows its work.
        </p>
        <Link href="/" className={styles.cta}>
          Start a new chat →
        </Link>
      </div>
    </main>
  );
}

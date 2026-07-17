import Link from "next/link";
import styles from "./not-found.module.css";

/**
 * The fallback for any URL that resolves to nothing. Renders inside the
 * AppShell, so the rail stays and only the content column is replaced.
 */
export default function NotFound() {
  return (
    <main className={styles.wrap}>
      <div className={styles.code}>404</div>
      <h1 className={styles.title}>No such page</h1>
      <p className={styles.body}>
        That URL doesn&rsquo;t point at anything — the link may be stale, or the
        thread it named was never started.
      </p>
      <Link href="/" className={styles.action}>
        Back to start
      </Link>
    </main>
  );
}

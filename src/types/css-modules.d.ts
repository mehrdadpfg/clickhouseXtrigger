/**
 * Types for CSS module imports, so `tsc --noEmit` stands on its own.
 *
 * Next.js declares these too, via `next-env.d.ts`. But that file is generated
 * by `next dev` / `next build` and is gitignored (the create-next-app default),
 * and it references `.next/dev/types/routes.d.ts` — another generated artefact.
 * So it exists on any machine that has run the app and on no machine that has
 * only cloned it.
 *
 * CI is the second kind. It installs and runs `tsc --noEmit` deliberately
 * WITHOUT a build, so no route modules are evaluated and no credentials are
 * needed — which also means nothing ever generates those declarations. Every
 * `import styles from "./X.module.css"` in the codebase therefore failed with
 * TS2307, and CI had been red on every push for days while every developer's
 * machine stayed green.
 *
 * Declaring it here rather than committing `next-env.d.ts` keeps the fix
 * independent of Next's generated output: this file is checked in, has no
 * dependencies, and does not go stale when Next changes what it generates.
 */
declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

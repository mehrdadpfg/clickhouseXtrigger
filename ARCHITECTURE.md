# Architecture

## Layout

```
src/
  app/                      Next.js App Router — routes only, kept thin.
    layout.tsx              Root shell (fonts, theme attribute).
    page.tsx                "/"        Start
    globals.css             Imports ../styles/tokens.css. Global resets only.
    icon.svg                Auto-served favicon.
    actions.ts              Server actions (Trigger session start + token mint).
    chats/[chatId]/         "/chats/:id"   Thread
    watch/                  "/watch"       Watchers
    boards/[boardId]/       "/boards/:id"  Dashboards
    tune/                   "/tune"        Optimize

  components/
    ui/                     Design-system primitives. No app/domain knowledge.
                            One folder per component: Component.tsx + Component.module.css.
                            StatTile/ DataTable/ Chart/ SqlBlock/ Badge/ Button/ Modal/
    chat/                   Chat composition (assistant-ui primitives live here).
    layout/                 NavRail/ HistorySidebar/ AppShell/

  lib/                      Framework-agnostic. No React, no JSX.
    env.ts                  Validated, typed env. The ONLY place process.env is read.
    clickhouse/
      client.ts             Single pooled client (createClient is a pool — never per-request).
      introspect.ts         listTables / describeTable — keeps the app dataset-agnostic.
      queryLog.ts           system.query_log reads, powering /tune.
    db/                     Postgres — app state only.
      client.ts             Pooled pg client.
      chats.ts              Chat list + titles for the history sidebar.
      watchers.ts           Watcher definitions + state.
      alerts.ts             Fired alerts.
      boards.ts             Boards + tiles.

  trigger/                  Trigger.dev tasks. Registered via trigger.config.ts `dirs`.
    chat.ts                 chat.agent — the durable conversation.
    watchers.ts             schedules.task — re-runs standing questions.
    tune.ts                 Analyses system.query_log; wait.forToken for approve-to-create.
    compare.ts              batchTrigger fan-out for compare-variants.

  styles/
    tokens.css              Design tokens. Single source of colour/type/radius.

  types/                    Shared types.

design/                     The source design (read-only reference, not shipped).
```

## Rules

1. **Nothing is hardcoded to `nyc_taxi`.** The app must work against any table.
   Schema comes from `lib/clickhouse/introspect.ts` at runtime — never pasted
   into a prompt or a component.
2. **`lib/` never imports from `components/` or `app/`.** Dependencies point one
   way: `app` → `components` → `lib`. `trigger/` may use `lib/`, never `components/`.
3. **`process.env` is read only in `lib/env.ts`.** Everything else imports `env`.
4. **`components/ui/` knows nothing about the domain.** A `StatTile` takes a
   label and a number; it does not know what a watcher is. Domain composition
   lives in `components/chat/` or the route.
5. **Colour, type, radius come from `styles/tokens.css`.** No hex literals in
   components. The labelled values in the Design Reference are authoritative.
6. **One ClickHouse client, one pg pool**, both module-scoped. `createClient`
   opens a connection pool; creating one per request leaks.
7. **Server-only modules stay server-only.** `lib/env`, `lib/db`, and
   `lib/clickhouse` must never be imported from a `"use client"` component —
   that would ship credentials to the browser. Cross the boundary with a server
   action or an RSC.

## Two datastores, on purpose

| Store | Holds | Why |
|---|---|---|
| **ClickHouse** | The analytical dataset + `system.query_log` | OLAP. Also already records every query's text, duration, and rows read — so `/tune` reads it directly rather than us duplicating a query log. |
| **Postgres** | Chats, watchers, alerts, boards | Small, frequent, mutating writes — exactly what ClickHouse is bad at. |
| **Trigger.dev** | Chat message history + run state | `chat.agent` persists conversation server-side; Postgres only stores the chat list/titles for the sidebar. |

## Credentials

Local dev: `.env` at the repo root (gitignored). Both Next.js and `trigger.dev dev`
read it. Copy `.env.example`.

**Deployed Trigger.dev tasks cannot see `.env`** — they run in Trigger's cloud.
The same vars must also be set in the Trigger.dev dashboard under **Environment
Variables**, or `trigger deploy` will succeed and then fail at runtime on a
missing `DATABASE_URL`.

# Vantage

**An analyst's chat agent over ClickHouse — answers that come to you, and act.**

Ask a question in plain language about millions of rows. The agent writes SQL,
runs it against [ClickHouse](https://clickhouse.com), and answers with real
numbers — showing its work. But it's not a chatbot over a database: an answer
can be pinned to a live **dashboard**, turned into a **standing watcher** that
re-runs forever, or handed to the agent to **optimize and tune** the schema
behind it. [Trigger.dev](https://trigger.dev) keeps those conversations and
background jobs durably alive.

<p>
  <a href="https://github.com/mehrdadpfg/vantage/actions/workflows/ci.yml"><img src="https://github.com/mehrdadpfg/vantage/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs" alt="Next.js 16">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5">
  <img src="https://img.shields.io/badge/ClickHouse-analytics-FFCC01?logo=clickhouse&logoColor=black" alt="ClickHouse">
  <img src="https://img.shields.io/badge/Trigger.dev-durable%20agents-A855F7" alt="Trigger.dev">
</p>

---

## The three shifts

This exists to demonstrate three things a plain LLM-over-a-database can't do:

1. **Pull → Push.** Stop making people ask. Subscribe to an answer — *"tell me
   when weekend tips drop 20% week-over-week"* — and it becomes a **watcher**
   that re-runs the query in the background forever. Info comes to you. Needs
   Trigger.dev schedules; impossible with a one-shot chat call.

2. **Read → Act.** The agent doesn't just flag a problem — it proposes a change
   (a materialized view, a projection, a rewritten tile query) and *pauses the
   run* until you approve it inline. Chat becomes a control surface. Trigger.dev
   is an orchestration engine, so wiring insight → action is native.

3. **Snapshot → Investigation.** Instead of one query → one chart, ask it to
   *build a dashboard* and it forms hypotheses, probes the data, and composes a
   dozen varied views — a durable, multi-step analysis Trigger.dev keeps alive
   across minutes, with ClickHouse making the queries feel instant.

## Features

### Ask — the chat agent

- **Plain-language questions.** Describe what you want; the agent reads the
  schema, writes the ClickHouse SQL, runs it, and answers with real numbers.
- **It shows its work.** Every turn carries the tool calls, the SQL behind each
  number, and the result — toggle *"show the agent's work"* to expand or collapse
  the reasoning trail. Every figure is traceable to a query that actually ran.
- **`@`-mention a table.** Type `@` in the composer to point the agent at a
  specific table (`@github_events`) — or at a saved dashboard (`@Overview`) to
  hand it that board's tiles as context. The composer autocompletes both.
- **It picks the table honestly.** When a question doesn't name a table and more
  than one could answer, the agent offers the real candidates as choices rather
  than silently guessing.
- **Search your history.** The chat switcher searches past conversations by
  title so you can jump back to an earlier thread.

### See — charts, stats, and tables

- **Tile types.** Three kinds of artifact: **KPI** headline numbers, **charts**,
  and raw **tables** — the agent picks the one that fits the answer.
- **~30 chart types, chosen by shape.** Not just bar/line/pie: area, grouped &
  stacked bar, lollipop, waterfall, rose, treemap, sunburst, scatter & bubble,
  connected scatter, regression, funnel, pyramid, heatmap, calendar heatmap,
  histogram, density, boxplot, strip, ECDF, radar, gauge, bullet, sankey, bump,
  slope, and candlestick. The agent names the *shape* of the result, then maps it
  to the right chart — a matrix becomes a heatmap, a flow becomes a sankey.
- **Chart titles.** Every chart and tile carries a short, descriptive title, so a
  wall of tiles reads at a glance.
- **Brush & click to drill.** Charts are interactive — drag a region to **brush
  and zoom** into a range (double-click to reset), and click a mark to drill into
  it. Line and area charts get a crosshair + tooltip; scatters zoom on both axes.
- **Partial-data notice.** When a time-bucketed query's most recent bucket is
  still filling (today's day, this month), the UI flags it — so a partial period
  isn't misread as a sudden drop.

### Keep — dashboards

- **Pin answers as tiles.** Any chart or stat from a chat can be pinned onto a
  **board** in one click; a dashboard-style answer lands as several tiles at once.
- **Build a dashboard, in detail.** Ask the agent to *"build a dashboard"* and it
  runs the full treatment: explore the table cheaply, then compose ~10–14
  distinct, *varied* tiles spanning analytical patterns — a trend and its
  change (period-over-period via window functions), a distribution, top-N,
  per-group top-N, a ratio, a cadence, a concentration cut — not the same
  `count()… GROUP BY` a dozen times.
- **Live, never a snapshot.** Each tile stores its query and re-runs against
  ClickHouse on load, with optional **auto-refresh** (off / 30s / 1m / 5m / 15m).
- **Rearrange.** Flip on *Arrange* mode to drag, resize (two axes), and reorder
  tiles on a twelve-column grid; the layout persists. A tile pinned from a chat
  lands at the same size it had in the answer.
- **Delete** a board (and its tiles) with a confirm.

### Watch — standing questions

- **Subscribe to a metric.** Turn an answer into a **watcher**: a scalar query
  plus a threshold (*rises above / drops below / changes by*) that re-runs on a
  schedule (hourly … weekly) as a Trigger.dev scheduled task.
- **It comes to you.** The Watch page shows each watcher's last run, current
  value, and whether it's firing; a breach sends an **email alert** (Resend), and
  every alert links back to the thread that created it.

### Optimize & Tune — schema actions *(early phase)*

> These two are the newest surfaces and still rough — expect sharp edges.

- **Tune** reads `system.query_log` and the physical shape of your tables,
  *investigates* what's costing you, and proposes fixes — materialized views,
  projections, skip indexes — as findings you **approve to apply** (the run
  pauses on a wait-token until you tick the ones you want). An approved MV can be
  backfilled in place, and you can apply findings one at a time and retry.
- **Optimize** (on a board) rewrites a dashboard's tile queries to read from the
  materialized views Tune created — shown as a git-style diff, applied per tile —
  turning a full-table scan into a lookup.

## The surfaces

| Route | What it is |
|---|---|
| **Chat** (`/chats`) | The durable conversation. Prose plus artifacts — stat tiles, tables, charts — and the SQL behind every number. |
| **Dashboards** (`/boards`) | Boards of pinned, live-re-running tiles. Arrange, refresh, optimize, delete. |
| **Watchers** (`/watch`) | Standing questions running in the background. Last run, current value, firing state. |
| **Tune** (`/tune`) | Schema advisor over the query log + physical profile. Approve-to-apply. *(early)* |
| **Settings** (`/settings`) | Alert recipient and app configuration. |

## Stack

- **[Next.js 16](https://nextjs.org)** (App Router, RSC) + React 19 + TypeScript
- **[ClickHouse](https://clickhouse.com)** — the analytical data plane *and* the
  query log that powers **Tune** (no duplicate log to maintain)
- **[Trigger.dev](https://trigger.dev) v4** — `chat.agent` for durable
  conversations, `schedules.task` for watchers, `wait.forToken` for
  approve-to-act (Tune findings, board Optimize)
- **Postgres** — small, frequent, mutating app state (chats, watchers, alerts,
  boards) — the writes ClickHouse is bad at. Runs on **ClickHouse Cloud's
  [Managed Postgres](https://clickhouse.com/docs/managed-postgres)**, so *both*
  datastores live on ClickHouse Cloud — one vendor, one bill, one place.
- **[AI SDK](https://sdk.vercel.ai)** + Anthropic Claude for the agent
- **[Bun](https://bun.com)** runtime · ECharts / [flint-chart](https://www.npmjs.com/package/flint-chart)
  for the charts · gridstack for the boards · shadcn-style UI primitives

Two datastores, on purpose — the analytics in ClickHouse, the mutating app state
in its Managed Postgres, both on ClickHouse Cloud. See
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Getting started

Prerequisites: [Bun](https://bun.com), a ClickHouse service (Cloud or local), a
Postgres database, and [Trigger.dev](https://trigger.dev) + Anthropic API keys.

```bash
# 1. Install
bun install

# 2. Configure — copy the example and fill in credentials
cp .env.example .env

# 3. Create the app-state tables (chats, watchers, alerts, boards)
bun run db:migrate

# 4. Run both dev servers (separate terminals)
bun run dev           # Next.js  → http://localhost:3000
bun run dev:trigger   # trigger.dev dev — required for chat, watchers & actions
```

The Trigger.dev dev server (`bun run dev:trigger`) must be running alongside
Next.js: the chat agent, watchers, Tune, and board Optimize all execute as
Trigger tasks. Without it the UI loads but conversations won't stream.

> **Deployed tasks can't see `.env`.** Trigger.dev tasks that run *deployed*
> execute in Trigger's cloud. The same vars must also be set in the Trigger.dev
> dashboard under **Environment Variables**, or `trigger deploy` succeeds and
> then fails at runtime on a missing credential.

## Scripts

| Script | Does |
|---|---|
| `bun run dev` | Next.js dev server |
| `bun run dev:trigger` | Trigger.dev dev server (`trigger.dev dev`) |
| `bun run build` | Production Next.js build |
| `bun run start` | Serve the production build |
| `bun run typecheck` | `tsc --noEmit` — the check CI runs |
| `bun run db:migrate` | Apply `migrations/*.sql` (idempotent, checksum-verified) |

## Project layout

```
src/
  app/         Next.js App Router — thin routes + server actions
  components/  ui/ (domain-free primitives) · chat/ · boards/ · tune/ · watch/
  lib/         Framework-agnostic. clickhouse/ · db/ (Postgres) · watchers/
  trigger/     Trigger.dev tasks: chat, tune, optimizeBoard, watchers, notify
  styles/      tokens.css — the single source of colour/type/radius
migrations/    Postgres schema, applied by db:migrate
```

Dependencies point one way: `app → components → lib`. `lib/` never imports React;
`process.env` is read only in `lib/env.ts`. The full rules are in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## License

[MIT](LICENSE) © 2026 Mehrdad

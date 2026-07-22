# Vantage

**An analyst's chat agent over ClickHouse — answers that come to you, and act.**

Ask a question in plain language about millions of rows. The agent writes SQL,
runs it against [ClickHouse](https://clickhouse.com), and answers with real
numbers — showing its work. But it's not a chatbot over a database: questions
can become *standing watchers* that re-run forever, and the agent can *act* on
what it finds, not just report it. [Trigger.dev](https://trigger.dev) keeps
those conversations and background jobs durably alive.

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
   when weekend tips drop 20% week-over-week"* — and it becomes a standing agent
   that re-runs the query in the background forever. Info comes to you. Needs
   Trigger.dev schedules; impossible with a one-shot chat call.

2. **Read → Act.** The agent doesn't just flag an anomaly — it proposes an
   action (open a ticket, kick off a backfill, draft the Slack message) and
   *pauses the run* until you approve it inline. Chat becomes a control surface.
   Trigger.dev is an orchestration engine, so wiring insight → action is native.

3. **Snapshot → Investigation.** Instead of one query → one chart, the agent
   forms hypotheses and drills: *"revenue dipped"* → runs a dozen queries across
   dimensions → *"it's iOS users in Germany after the v3.2 release."* Durable,
   multi-step root-cause analysis Trigger.dev keeps alive across minutes, with
   ClickHouse making the queries feel instant.

## The surfaces

| Route | What it is |
|---|---|
| **Explore** | Point at any table; the agent probes it (four "verbs" + cross-table discovery) so you know what's *in* the data before you ask. |
| **Chat** | The durable conversation. Agent turns carry prose plus artifacts — stat tiles, tables, model-generated charts, and the SQL behind every number. |
| **Watchers** | Standing questions running in the background. Last run, current value, whether it's firing. This is the "info comes to you" surface. |
| **Compare** | Fork any answer into N parallel branches — same question, different assumptions — each its own background job, small multiples on a shared scale. |
| **Dashboards** | Pin answers as tiles onto boards. |
| **Optimize** | Reads `system.query_log` to surface slow/expensive queries and proposes fixes (approve-to-apply). |

## Stack

- **[Next.js 16](https://nextjs.org)** (App Router, RSC) + React 19 + TypeScript
- **[ClickHouse](https://clickhouse.com)** — the analytical data plane *and* the
  query log that powers **Optimize** (no duplicate log to maintain)
- **[Trigger.dev](https://trigger.dev) v4** — `chat.agent` for durable
  conversations, `schedules.task` for watchers, `wait.forToken` for
  approve-to-act, `batchTrigger` for the compare fan-out
- **Postgres** — small, frequent, mutating app state (chats, watchers, alerts,
  boards) — the writes ClickHouse is bad at
- **[AI SDK](https://sdk.vercel.ai)** + Anthropic Claude for the agent
- **[Bun](https://bun.com)** runtime · ECharts / shadcn-style UI primitives

Two datastores, on purpose — see [`ARCHITECTURE.md`](ARCHITECTURE.md).

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
Next.js: the chat agent, watchers, and approve-to-act all execute as Trigger
tasks. Without it the UI loads but conversations won't stream.

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
  components/  ui/ (domain-free primitives) · chat/ · layout/ · boards/ · tune/
  lib/         Framework-agnostic. clickhouse/ · db/ (Postgres) · discover/
  trigger/     Trigger.dev tasks: chat, watchers, tune, compare, verb, discover
  styles/      tokens.css — the single source of colour/type/radius
migrations/    Postgres schema, applied by db:migrate
```

Dependencies point one way: `app → components → lib`. `lib/` never imports React;
`process.env` is read only in `lib/env.ts`. The full rules are in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## License

[MIT](LICENSE) © 2026 Mehrdad

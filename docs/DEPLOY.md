# Deploying AVEX Pay

Two decisions, and they are separable: where Postgres lives, and where the API runs. This
document is the honest split — what can go to Supabase today, what cannot, and why.

## What runs where

| Piece | Supabase | VPS | Note |
|---|---|---|---|
| Postgres | ✅ | ✅ | Drizzle migrations either way |
| HTTP API (every route) | ✅ Edge Function | ✅ Node process | one `compose()`, two entry points |
| Background jobs (webhooks, commission, payouts) | ✅ `pg_cron` → `/internal/jobs` | ✅ in-process timers | same jobs, same advisory locks |
| Chain watcher | ❌ | ✅ | not built yet — see below |
| Settlement / sweep signer | ❌ | ✅ | holds the key that moves funds |

**Today the API has no long-lived chain loop at all.** `Watcher` and `SettlementRunner`
exist in `@avex/core` with their own tests, and nothing instantiates them: `main.ts` loads
the watcher's cursors, logs them, and says so. So everything that currently exists can run
on Supabase. The VPS becomes necessary when the watcher and the settlement runner are wired,
because both need a process that outlives a request — cursor continuity, reorg rewind, and a
signing key that must not sit in a runtime that scales to zero.

## Postgres

Migrations are Drizzle's, and they stay Drizzle's. Do not let Supabase's migration tooling
near them: two journals pointed at one database is how one diverges from reality.

Two connection strings, and the difference is not cosmetic:

```
DATABASE_URL=postgres://…@…pooler.supabase.com:6543/postgres   # request path, pooled
DIRECT_DATABASE_URL=postgres://…@db.….supabase.co:5432/postgres # migrations, direct
```

- **Migrations need the direct one.** This schema creates enums, and `CREATE TYPE` through a
  transaction-mode pooler fails in a way that reads like a syntax error in the migration.
  `drizzle.config.ts` prefers `DIRECT_DATABASE_URL` for exactly this.
- **The request path must turn prepared statements off.** A transaction pooler hands each
  statement whichever backend is free, so one prepared on the first connection is unknown on
  the next — and the error, `prepared statement "s1" does not exist`, names nothing in this
  codebase. `createDatabase` infers this from the URL (port 6543, or a `pooler.` hostname)
  and `DATABASE_PREPARE=true|false` overrides it. The first log line reports which it chose,
  so a wrong guess is visible immediately rather than on the first slow query.

```bash
npm run -w @avex/api db:migrate      # uses DIRECT_DATABASE_URL
```

## The API on Supabase Edge Functions

`supabase/functions/api/index.ts` is an adapter and nothing more: it turns a web `Request`
into `app.inject()` — Fastify's own in-process request path, the one every integration test
here already uses — and the response back. The service graph comes from `compose()`, the
same function `main.ts` calls, so there is no second copy of the wiring to drift.

```bash
npm run -w @avex/api build           # the function imports apps/api/dist
supabase functions deploy api --no-verify-jwt
supabase secrets set --env-file .env.production
```

Set on the function: `DATABASE_URL` (pooled), `DIRECT_DATABASE_URL`, `APP_URL`,
`MEMO_SECRET`, `FORWARDER_FACTORIES`, `FORWARDER_CREATION_CODE`, `FEE_COLLECTORS`,
`EVM_RPC_URLS`, `CRON_SECRET`, and `RUN_JOBS_IN_PROCESS=false`.

Do **not** set `SETTLEMENT_KEY_HEX` here. Nothing in this process sweeps funds, so it has no
use for a key that could — and `LocalKeyProvider` refuses to hold one when `NODE_ENV` is
production anyway.

Not verified from this repository: there is no Deno in the development container and no
Supabase project to deploy into, so the adapter is written and reviewed but has not been
executed. The pieces it depends on — `compose()`, `app.inject()`, the pooler inference — are
all tested here.

## The jobs, without a process to hold them

Three jobs run on a clock: webhook delivery, commission period close, payout change
application. Defined once in `apps/api/src/jobs.ts`, driven two ways.

A server runs them on timers (`RUN_JOBS_IN_PROCESS=true`, the default). A deployment with no
process has a scheduler call `POST /internal/jobs?job=<name>`, authenticated by
`x-cron-secret`. Apply `deploy/supabase/cron.sql` once, after putting the URL and the secret
in the vault — the file says how. It uses `pg_cron` for the schedule and `pg_net` so the HTTP
call does not block the scheduler.

Each job takes its own Postgres advisory lock, and that is not decoration: as timers in one
process they could not overlap, so the code never needed one. A scheduler can fire while the
previous run is still going, and two API instances behind a load balancer both hold a timer —
either of which delivers a merchant's payment webhook twice.

`/internal/jobs` is the only route here authenticated by a shared secret rather than a
session or a scoped key, which is why it can do only this one thing. With no `CRON_SECRET`
set it answers 404, not 403: a deployment driving its jobs with timers has no use for the
route, and "forbidden" would advertise that a secret exists to be guessed.

## What is switched off, and why

`supabase/config.toml` disables PostgREST, GoTrue, Storage and Realtime. The reasoning is in
the file, and the load-bearing one is PostgREST: exposing the tables moves tenancy into row
policies, and — more to the point — puts every money invariant one direct write away from
being bypassed. The fee floor, the gross-up, the paid/underpaid tolerance, payment
idempotency on `(chain, tx_hash, transfer_index)`, reorg reversal: all in services. A client
that can write a row needs each of them duplicated as a trigger, and two enforcement points
means one drifts. The panel is a static file talking to this API, which is the right shape
and costs nothing to keep.

## The VPS, when the watcher lands

One process, `apps/api` with:

```
RUN_JOBS_IN_PROCESS=true
SETTLEMENT_KEY_HEX=…        # development only; production supplies a KMS-backed KeyProvider
EVM_RPC_URLS=bsc=https://…
```

It needs the same database and nothing else from Supabase. Run it with the jobs on timers
and leave the cron schedules unapplied, or run it with `RUN_JOBS_IN_PROCESS=false` alongside
the Edge Function and let cron drive them — the locks make either safe.

## Availability, stated plainly

Supabase is a US company on AWS and its terms exclude sanctioned jurisdictions. For a
company that falls under those, the realistic failure is not a bill: it is an account closed
with the production database inside it, possibly without notice and possibly without an
export. That is an availability risk to weigh, not a legal opinion.

`supabase/postgres` is Apache-2.0 and is just Postgres with extensions — including `pg_cron`
and `pg_net`, so `deploy/supabase/cron.sql` applies to a self-hosted instance unchanged. A
VPS running that image plus this API is the same system with none of that exposure, and the
only thing lost is somebody else carrying the pager.

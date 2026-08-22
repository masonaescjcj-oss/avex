# Deploying AVEX Pay

Two decisions, and they are separable: where Postgres lives, and where the API runs. This
document is the honest split — what can go to Supabase today, what cannot, and why.

## What runs where

| Piece | Supabase | VPS | Note |
|---|---|---|---|
| Postgres | ✅ | ✅ | Drizzle migrations either way |
| HTTP API (every route) | ✅ Edge Function | ✅ Node process | one `compose()`, two entry points |
| Background jobs (webhooks, commission, payouts) | ✅ `pg_cron` → `/internal/jobs` | ✅ in-process timers | same jobs, same advisory locks |
| Chain watcher | ❌ | ✅ | `npm run -w @avex/api watch` |
| Settlement / sweep signer | ❌ | ✅ | still not wired — see below |

The watcher is a second process, `apps/api/dist/watcher.js`, and it is the one thing here
that cannot be serverless. It holds a cursor per chain that has to advance monotonically, it
rewinds that cursor when a reorg is found, and it decides that a payment happened. A runtime
that scales to zero between invocations can do none of that: two overlapping invocations
would scan the same range twice and race each other's cursor writes.

It takes the `chainWatcher` advisory lock for the life of the process, so a deploy that
starts a second copy without stopping the first has the second exit rather than double-scan.
It watches every EVM chain that has both an RPC endpoint and a forwarder factory configured,
and refuses to start if that set is empty — a watcher with nothing to watch is
indistinguishable from a healthy one, and the deployment would go on believing payments were
being detected.

```bash
npm run -w @avex/api build
DATABASE_URL=… EVM_RPC_URLS=bsc=https://… FORWARDER_FACTORIES=bsc=0x… \
  npm run -w @avex/api watch
```

**Sweeping on the EVM chains: one path now, and one thing missing.** There used to be two
settlement designs. `SettlementRunner` takes a `ChainSigner` — `pendingNonce`/`broadcast`/
`receipt`, which `EvmChainSigner` implements — and owns the nonce, a spend cap, a
per-transaction ceiling and the replacement of stuck transactions. `EvmAdapter.settle()` took a
different interface and broadcast through it, with no nonce and no memory of what was
outstanding; nothing implemented that interface, and the watcher passed a stub that threw.

That is resolved by removing the wrong one rather than writing it. The adapter seam is now
`prepareSettlement(batch)`, which returns the bytes to broadcast or null for a chain that
settles on receipt, and `SettlementQueue` hands them to the runner. The queue keeps its own
job — hold for a cheaper block, batch, go anyway after a deadline — and a refusal from the
runner is no longer counted as a failed attempt, because "the spend window is full" must not
abandon a merchant's settlement.

What is still missing is a key. Sweeping needs an account that pays gas, `LocalKeyProvider`
refuses to hold one when `NODE_ENV` is production, and no decision has been made about where
it should live instead. Until then the pipeline is assembled and idle: nothing on EVM sweeps,
and funds wait at their deposit addresses, which can only ever pay their own merchant.

TRON needs none of this — see below.

**TRON needs none of it, and that is the point.** Its deposit addresses are the merchant's
own — `addressModel: 'pooled'` — so the payer's transfer lands in their wallet and there is
nothing to sweep, no key to hold, and no settlement transaction to build. Which removed the
two hardest parts of a TRON integration: no protobuf encoding and no signing. `TronAdapter`
polls and nothing else.

It polls over TRON's Ethereum-compatible JSON-RPC rather than TronGrid's own event API, so
its endpoint belongs in `EVM_RPC_URLS` beside the others:

```
EVM_RPC_URLS=bsc=https://…,tron=https://api.trongrid.io/jsonrpc
```

That is not a misfiling. A TRON node speaks `eth_blockNumber`, `eth_getLogs` and
`eth_getBlockByNumber`, TRC-20 is ERC-20 with a different address encoding, and a `Transfer`
event is the same event with the same topic — so the adapter shares its shape, its reorg
handling and its block source with the EVM one. TronGrid's event endpoint pages by timestamp,
which cannot express "rescan from block N" and therefore cannot survive a reorg honestly.

TRON needs no forwarder factory, and `watchableChains` reflects that: an EVM chain without one
is skipped, because the addresses it would look for are hashes over a factory that does not
exist; a pooled chain is watched on its RPC endpoint alone.

What crosses the boundary twice per poll is addresses. The filter goes out as 20-byte hex and
recipients come back the same way, while everything stored and compared here is Base58Check.
Getting that wrong finds no payments at all, on the chain expected to carry the most volume,
and looks exactly like a quiet chain — so both directions are mutation-tested.

## The front end, on Vercel

Five static pages, no framework, no build server. `npm run build:static` builds the page
workspaces, then `deploy/build-static.mjs` assembles `deploy/out/` and injects the two values
that break a split deployment silently: `avex-api` (where the API is) and `avex-dashboard`
(where the site's sign-in button points).

Live at **https://avexpay.net**, project `avex-pay` under the `isaacs-projects-dad539ec`
team. `www` 308s to the apex so there is one origin, not two.

```bash
vercel link --project avex-pay
printf 'https://api.avexpay.net' | vercel env add AVEX_API_URL production
vercel --prod
```

`AVEX_API_URL` is a *build* variable, not a runtime one — it is read by the build script and
baked into a meta tag. Changing it needs a redeploy, not a restart.

Three things about the configuration that are not obvious:

- **`installCommand` is `npm ci --include=dev`, and the flag is load-bearing.** The page
  builds run `tsc`, and `solc` compiles the contracts — all devDependencies. A build host
  that sets `NODE_ENV=production` makes plain `npm ci` skip them, and the failure arrives as
  a missing module rather than as anything about environments.
- **`cleanUrls` and rewrite destinations do not mix.** With `cleanUrls: true`, `/pay.html`
  308s to `/pay`, so a rewrite whose destination is `/pay.html` lands on a redirect and the
  dynamic path 404s. Destinations are extensionless for that reason. It is also why
  `/dashboard` and `/admin` need no rewrite at all: `cleanUrls` already resolves them, and a
  rewrite from `/dashboard` to `/dashboard` would be a loop.
- **`.vercelignore` excludes `.env*`.** `vercel link` writes a `.env.local` holding a live
  OIDC token, and the CLI uploads the working tree.

Deployment is by CLI, not by git push: connecting the repository needs a GitHub login
connection on the Vercel account, which this one does not have. Nothing depends on it —
`vercel --prod` from a checkout is the whole deployment.

The panel loads before the API exists, and that is worth saying out loud because it looks
like success: `/dashboard` renders, sign-in posts to `https://api.avexpay.net/v1/auth/login`,
and until something answers there the form fails. The static host being up is not the
product being up.

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
`MEMO_SECRET`, `SMTP_URL`, `MAIL_FROM`, `FORWARDER_FACTORIES`, `FORWARDER_IMPLEMENTATIONS`, `FEE_COLLECTORS`,
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

## The VPS

Two processes, or one if the API runs there too:

```bash
npm run -w @avex/api start   # the HTTP API; RUN_JOBS_IN_PROCESS=true drives the jobs
npm run -w @avex/api watch   # the chain watcher, one per deployment
```

The watcher needs `DATABASE_URL`, `EVM_RPC_URLS` and `FORWARDER_FACTORIES`, and nothing
else. It serves no HTTP: a payment it credits reaches a merchant through the webhook rows it
writes, which the API's own scheduler drains.

Both may run alongside the Edge Function against the same database. The locks make that
safe — set `RUN_JOBS_IN_PROCESS=false` on whichever side should not hold the timers, or
leave both on and let the loser of each tick skip.

The catalogue is read once at watcher startup, deliberately: `acceptedAssets` decides which
contracts count as payments, and a set that changed underneath a scan would mean the same
block is interpreted two ways depending on when it was read. Listing a new token is a
restart.

**A known limit, found by running it.** `EvmAdapter.poll` asks for one `eth_getLogs` covering
every accepted contract at once — it used to ask once per token, which made a poll cost as
many requests as the catalogue holds, and merchants can submit contracts so that number grows
without anybody deciding to grow it. What is left is the other end of the same problem:
providers cap how many addresses a single filter may carry, usually in the low hundreds. The
listed, approved, curated set is well under that; a deployment that lists hundreds of
merchant-submitted tokens on one chain will need the filter split into batches. The startup
line logs the count so the number is visible before it becomes a 400 from the provider.

## Availability, stated plainly

Supabase is a US company on AWS and its terms exclude sanctioned jurisdictions. For a
company that falls under those, the realistic failure is not a bill: it is an account closed
with the production database inside it, possibly without notice and possibly without an
export. That is an availability risk to weigh, not a legal opinion.

`supabase/postgres` is Apache-2.0 and is just Postgres with extensions — including `pg_cron`
and `pg_net`, so `deploy/supabase/cron.sql` applies to a self-hosted instance unchanged. A
VPS running that image plus this API is the same system with none of that exposure, and the
only thing lost is somebody else carrying the pager.

## Driving the jobs

`POST /internal/jobs` runs them for a deployment with no process to hold timers in. It accepts
the secret as `x-cron-secret` or as `Authorization: Bearer` — the second because Vercel's
scheduler sends that and cannot be told to send anything else.

One caveat that decides the deployment shape: the webhook drain wants to run every ten seconds,
and no hosted scheduler fires that often. A deployment driven only by a hosted cron retries
failed webhooks once a minute at best. The gateway needs a long-running host anyway, for the
watcher — see `docs/GO-LIVE.md`.

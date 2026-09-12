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
| Settlement / sweep signer | ❌ | ✅ | runs inside the watcher process; needs a key |

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

What is still missing is a key. The pipeline itself is wired: the watcher process calls
`startSettlement`, which builds a signer, a `SettlementRunner` and a `SettlementCycle` per EVM
chain, reads receipts, marks an invoice settled only when a transaction carrying it confirms, and
hands new work to the queue. It runs only when `SETTLEMENT_KEY_HEX` is set, and says so at every
startup when it is not.

So what is left is the key, and where it lives is a decision rather than a variable:
`LocalKeyProvider` refuses to hold one when `NODE_ENV` is production, because a copy of it is a
wallet somebody else can drain. Until that is answered, nothing on EVM sweeps and funds wait at
their deposit addresses — which can only ever pay their own merchant, so the failure is a delay
rather than a loss.

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

## Solana is pooled too, and its endpoint is not in that variable

Same model — the payer sends to a wallet the merchant owns and the exact amount names the
invoice — and a completely different protocol. A Solana node answers none of the `eth_*`
calls, so its endpoint has its own setting:

```
SOLANA_RPC_URLS=https://your-endpoint.example
```

Not in `EVM_RPC_URLS`, and that is the point of the separate name: that map is also read by
the gas oracle and the contract prober, and a Solana URL in it would give both an endpoint
that replies "method not found" to everything they ask. A key naming `solana` in there is
therefore treated as a typo and ignored.

There is no default. The public endpoint at `api.mainnet-beta.solana.com` works and is rate
limited hard enough that a poll trips over it intermittently, which is the worst of the
available failures — a chain that is on, mostly working, and occasionally missing a payment.
Name an endpoint you trust, or leave the chain off.

What a Solana poll costs, so the rate limit can be reasoned about rather than guessed at:
one request for the finalized slot, one per watched account for its recent signatures, and
one per new transaction. With no Solana wallet registered it is a single request every five
seconds. Reorg handling is switched off for the chain — a finalized slot is rooted by a
supermajority of stake and never removed — so none of the ~130 block-hash reads the EVM
chains make per poll happen here.

The account a payer's transfer actually reaches is not the merchant's address. It is the
*associated token account* for that wallet and that mint, and it is derived locally rather
than asked for: the derivation is in `chains/solana/ata.ts` and is held against real mainnet
accounts by its test. That is deliberate, and it is what makes a merchant's *first* payment
on the chain work — the account does not exist until the transfer that creates and credits
it, so an adapter that waited to be told the address would be watching nothing at the moment
it mattered.

`getTokenAccountsByOwner` is still called once per wallet and mint, where the endpoint serves
it, to pick up a token account that is not the associated one. publicnode's free Solana
endpoint answers that method with HTTP 403; the watcher says so once and carries on, because
a payer's wallet computes the associated account from the address it was given and cannot
know about any other. It matters only for a merchant whose own wallet keeps that token
somewhere else, which normal wallets do not.

## The chain's own coin: BNB, ETH, POL, TRX, SOL, TON

A payment in a chain's own coin emits no event. Every other kind this system detects is an
ERC-20 style `Transfer` log, and a log can be filtered — one `eth_getLogs` covers five hundred
blocks and every address at once. A transfer of BNB is a field on a transaction, so seeing it
means reading transactions, and a block of BNB Chain is a quarter of a megabyte.

So both EVM and TRON adapters skipped native assets, with a comment saying it needed "trace or
balance polling". That was true and it was also a hole: BNB, ETH, POL and TRX are approved and
listed, so a merchant could enable BNB, a customer could pay in BNB, the money would arrive in
the merchant's wallet, and nothing would ever notice. The payer's transfer confirmed and the
invoice stayed unpaid.

The way it works now is a cheap question every poll and an expensive one only when the cheap
one says yes. A merchant's wallet is quiet: its balance changes when somebody pays and at no
other time. So each poll reads the balance of each watched wallet — one small call per wallet,
batched into a single request — and only when one has gone *up* does it read that poll's blocks
to find the transaction that raised it.

Three consequences worth knowing:

- **It costs nothing when no native coin is enabled.** The pass is not built at all unless the
  chain's own coin is one of the merchant's accepted assets.
- **A native invoice needs a wallet of the merchant's own.** The balance probe works for a
  handful of wallets, not for the thousands of per-invoice forwarder addresses an EVM chain
  derives. So the checkout marks the coin unavailable without one, and invoice creation refuses
  it, rather than issuing something unpayable.
- **A payment landing during a restart is missed.** The baseline is held in memory, because
  fetching it means `eth_getBalance` at an old block and public nodes answer that with "archive
  requests require a personal token". The first poll after a start records the balance, so a
  payment already in it is not seen arriving. `--credit-tx` credits it by hand.

Two things a public endpoint does that this had to be built around, both found by running it
against BNB Chain rather than against a fixture. publicnode refuses
`eth_getTransactionReceipt` outright with HTTP 403, for a transaction three blocks old, batched
or not — so the balance itself is the confirmation: when the transactions addressed to a wallet
add up to exactly what it gained, all of them moved their money and nothing else did, which is
a stronger statement than a receipt's status flag. And where the sums disagree, nothing is
credited and the difference is reported, because the difference could be a reverted transfer,
gas the wallet spent, or a contract's internal call, and none of those can be told apart from
outside.

What it cannot see is a transfer made by a contract rather than by a transaction — an exchange
paying out through a batching contract. The value moves in an internal call that appears in no
transaction's `to` and in no log; only a tracing API would show it. When a balance rises with no
transaction to account for it, the watcher says so, and `--credit-tx` is the remedy.

## TON is pooled too, and the payer names the invoice

Same model again — the merchant's own wallet, from their pool — with one thing no other
chain here has: a transfer carries a text comment, and every wallet and exchange has a field
for it. So the invoice is identified exactly rather than inferred from its amount, and the
amount rules are the fallback for a payer who leaves the comment out.

## Crediting a transfer the watcher never saw

```
cd /opt/avex
sudo -u avex npm run replay-tx --workspace @avex/api -- <chain> <transaction hash>
```

An EVM or TRON chain takes an `0x…` hash; `ton` takes the hash an explorer shows, in either
the base64 or the hex form. It hands the transfer to the same payment sink the watcher uses,
with the same matching rules and the same idempotency — replaying something already credited
says so and changes nothing, so it is safe to run twice.

It is for the transfer a poll missed: an endpoint that refused every request for an hour while
the cursor moved past, a window that closed, or a rule that was wrong when it ran. The last of
those has happened once, on TON — see below.

## Telegram Stars, when AVEX drives the bot

A merchant can always take Stars with their own bot and report the charge over the API;
that needs nothing here. Putting Stars on the *hosted* checkout does, because then this
service talks to Telegram and Telegram talks back to it:

```
PUBLIC_API_URL=https://api.example.com   # where Telegram delivers updates
TOKEN_ENCRYPTION_KEY=…                   # generated by install.sh
```

`PUBLIC_API_URL` is not `APP_URL`. `APP_URL` is the pages origin; this is where *this
process* answers, and it is the URL handed to Telegram's `setWebhook`. Without it a
merchant trying to connect a bot is told the server has not been given its own address —
which is better than registering a webhook that points at the static site.

`TOKEN_ENCRYPTION_KEY` encrypts the stored bot tokens. Every other credential here is
hashed, because nothing needs the original back; a bot token has to be presented to
Telegram on every call, so it is the one value that survives a round trip. **Losing this
key loses those tokens** — they cannot be recovered and every merchant would have to
connect their bot again. Back it up with the database password. `install.sh` generates
one, and appends it to an `api.env` written before this existed.

TON's endpoint is an indexer, not a node, and it has its own setting:

```
TON_API_URL=https://toncenter.com/api/v3
TON_API_KEY=…            # optional, and you want one
```

It cannot be a node, and that is not a preference. A jetton transfer — USDT on TON is a
jetton — does not arrive at the merchant's address at all: it arrives at that wallet's
*jetton wallet*, a contract whose address is a hash of its own code and data, and the comment
is inside a payload cell. Reading either from a node means building TL-B cells. toncenter's
v3 index has done both already: one request per wallet gives the amount, the jetton, the
sender and the comment decoded.

Without a key, toncenter allows roughly one request a second. A single poll is three
requests — the head, then the jetton transfers and the plain transfers for each wallet — so
the watcher paces itself to one a second when no key is set, and waits out a refusal rather
than failing the round. That is enough to work: it is not enough to be quick. One wallet is
about three seconds a poll and ten wallets is closer to half a minute, which is half a minute
a payer spends looking at a page that has not noticed them yet.

With a key the pace is ten times that and the limit stops mattering. Get a key.

This used to be a real outage rather than a slow poll: the requests went out back to back, so
the second and third of every round were refused and the whole poll failed. A merchant's TON
payment went unseen with `ton api masterchainInfo: HTTP 429` in the log. If you see a 429 now
it is a line in the log and a slower round, not a payment nobody saw.

### A TON transfer can be "aborted" and still arrive

Worth knowing if you ever read a TON transaction by hand. A transaction has phases, and the
*credit* phase runs before the *compute* phase: an incoming transfer lands first and the
contract runs afterwards. `aborted` describes the compute phase, not the money.

A wallet that has never *sent* anything has no code deployed, so paying into it produces
`aborted: true` with `compute_ph: { skipped: true, reason: "no_state" }` — and
`credit_ph: { credit: … }` for the full amount, which is sitting in the wallet. That is the
state every new merchant's TON wallet is in, and this watcher used to discard those rows. Two
real payments were lost to it.

What genuinely does not arrive: a message with `bounced: true` (somebody's refund coming back),
a *bounceable* message that aborted (the value is returned, minus fees — which is why the
checkout shows the `UQ…` non-bounceable form), and an account destroyed in the same
transaction.

Two things about TON that were wrong before and are worth knowing if you read the old code:
the address must be given to the index in its **friendly** form (`UQ…`/`EQ…`), because the
raw `0:hex` form it answers with returns an empty list and a 200 rather than an error; and
the jetton master comes back raw and upper case while the registry holds it friendly, so both
sides go through the address codec before anything is compared. Each of those, got wrong,
looks exactly like a chain nobody is paying on.

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

A payment the watcher missed — the node refused every log query for an hour, or the process
was down longer than the public node keeps logs — is credited by hash, with the same rules the
watcher applies: `sudo bash deploy/install.sh --credit-tx bsc 0x…`. Idempotent.

Five jobs run on a clock: webhook delivery, commission period close, payout change
application, invoice expiry, and the sweep over transfers parked at shared wallets. Defined
once in `apps/api/src/jobs.ts`, driven two ways.

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

The watcher needs `DATABASE_URL` and an endpoint for at least one chain — `EVM_RPC_URLS`,
`SOLANA_RPC_URLS`, `TON_API_URL`, or any of them — plus `FORWARDER_FACTORIES` for any chain
it should also settle on, and nothing else. It serves no HTTP: a payment it credits reaches a merchant through the webhook rows it
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

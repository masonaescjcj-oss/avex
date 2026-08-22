# Going live

What is left, in the order it has to happen, and who has to do it. Kept in the repository
rather than in a chat because the answer changes as things land, and a checklist nobody can
find is a checklist nobody follows.

## The shape of a deployment

Two hosts, and the split is forced rather than chosen.

**Static pages — Vercel.** The marketing site, the checkout, the merchant dashboard and the
admin panel are four self-contained HTML files. `deploy/build-static.mjs` assembles them and
`vercel.json` serves them. This is already live at avexpay.net.

**The gateway — one long-running process host.** A small VPS or container. Three things need a
process that stays up, and none of them can run in a serverless function:

- **The watcher** (`npm run watch`) polls chains on a loop. A function that is frozen between
  requests cannot poll.
- **The background jobs**, if driven by in-process timers. The webhook drain runs every ten
  seconds, and no hosted scheduler fires that often — Vercel Cron's floor is one minute.
- **The settlement runner** holds a nonce and a queue across attempts.

The API itself would run happily in either place. It runs on the process host because the
watcher is already there and both want the same database pool.

A deployment that only offers TRON needs no settlement runner: the payer's transfer lands in
the merchant's own wallet and nothing of ours moves afterwards. That is the shortest path to
taking real money, and it is the reason the order below is what it is.

## Done

- Non-custodial deposit addresses on EVM: 87-byte clones, 86,546 gas to settle, every parameter
  committed to by the address.
- Settlement: the watcher process sweeps forwarders, records every transaction, and marks an
  invoice settled only when a transaction carrying it confirms.
- TRON end to end: pooled wallets, amount-based matching, the watcher, the commission ledger.
- Invoices, checkout, receipts, webhooks, the merchant dashboard, the admin panel.
- The payer pays the network fee; invoices below what a chain can carry are refused.
- Transactional email over SMTP.

## Left, in order

### 1. A database — *needs the operator*

A Postgres connection string. Supabase is fine: Project Settings → Database → Connection
string → URI, the **direct** one on port 5432 rather than the pooler on 6543 (this schema
creates enum types, and `CREATE TYPE` through a transaction pooler fails in a way that reads
like a syntax error in the migration). Then `npm run db:migrate --workspace @avex/api`.

Nothing else on this list can be tested without it.

### 2. Mail — *needs the operator*

`SMTP_URL` and `MAIL_FROM`. Any provider, or the operator's own server. The sending domain
needs SPF and DKIM records, or a verification link is delivered to spam, which for a link is
the same as not delivered.

Without it the console transport logs every message and sends nothing — which means no merchant
can confirm an address, and the twenty-four-hour delay on a payout address change protects
nobody.

### 3. The API on a host, and DNS — *needs the operator*

`api.avexpay.net`, and `DASHBOARD_ORIGINS` set to the static host so the panels can reach it.

### 4. TRON deposit wallets — *needs the operator*

Three to five TRON addresses, registered in the dashboard. **The keys stay with the merchant**;
we only ever hold the addresses. A TRON endpoint goes in `EVM_RPC_URLS` as
`tron=https://api.trongrid.io/jsonrpc` — TRON exposes an Ethereum-compatible JSON-RPC, which is
why it is that variable and not another.

### 5. Testnet, end to end — *both*

An invoice, a real transfer, the watcher crediting it, the webhook arriving, the receipt
rendering. Then the same on a phone, scanning the QR from a real camera, which has never been
done.

**TRON can go live after this.** Note what it means commercially: on TRON the commission is
billed to the merchant's balance rather than taken on chain, so revenue accrues as a receivable
until a chain that can take a cut is live. It is collected from a later EVM invoice, or by
asking.

### 6. The settlement runner — *done, needs a key*

The watcher process now also settles: `startSettlement` builds a signer, a runner and a cycle
per EVM chain, and `SettlementCycle` reads receipts, marks invoices settled, and hands new work
to the queue. It runs only when `SETTLEMENT_KEY_HEX` is set, and says so on every startup when
it is not — a gateway that detects payments and never moves them looks healthy from every angle
except the merchant's balance.

What that leaves for the operator is the key itself, which is item 8.

### 7. Deploy the contracts — *needs the operator*

```
RPC_URL=https://… node contracts/deploy.mjs --chain bsc --dry-run   # cost, nothing sent
DEPLOY_KEY_HEX=0x… RPC_URL=https://… node contracts/deploy.mjs --chain bsc
```

`contracts/deploy.mjs` deploys `ForwarderLogic`, then `ForwarderFactory` with that address, and
prints the two environment lines. It refuses to sign if the endpoint's chain id disagrees with
`--chain`, and — the part that matters — it asks the deployed factory to predict a deposit
address and compares it with what this build derives. A disagreement means every published
address would be one the factory can never settle, with no error anywhere to notice it by, so a
mismatch refuses to print the configuration at all.

Needs a wallet with enough native token for two deployments; the dry run says how much. Every
deposit address is a hash over the logic address, so a redeployment is a new set of addresses
and cannot be done casually after launch — record both addresses alongside the commit that
produced them.

### 8. A settlement key and a gas wallet — *needs the operator*

`LocalKeyProvider` refuses to hold a key in process memory when `NODE_ENV` is production, and
that refusal is correct: the key can move every merchant's funds out of a forwarder to that
merchant, and holding it in an environment variable makes it as exposed as the process. A
KMS-backed `KeyProvider` is a small class against whatever the operator's host offers.

The same wallet pays gas. It needs a balance and an alarm on that balance.

### 9. Operations — *code and operator*

- Alerting: set `OPERATOR_EMAIL`. Critical alerts — a gas wallet that cannot cover a
  settlement, a nonce nothing can get past, a settlement that reverted — are emailed once per
  kind per fifteen minutes. Warnings stay in the log. Without the address everything is logged
  and settlement says so at startup.
- A cursor that stops advancing for ten minutes, or five failed polls in a row, is a critical
  alert on the same address. That is the failure nobody reports: a payer's transfer confirms, the
  merchant sees nothing, and each blames the other while every other signal looks healthy.
- Still to build: an alert when the price circuit breaker opens. It is visible in the admin panel
  and does not reach out — and unlike the others, a merchant does notice, because their checkout
  starts refusing currencies.
- Alerting on: watcher cursor falling behind, a settlement queue that stops draining, the price
  circuit breaker opening, the gas wallet running low.
- Database backups with point-in-time recovery.

## Not blockers

- **Solana.** Designed, not implemented. Nothing depends on it.
- **Telegram Stars.** Works, but needs the merchant's own bot, so it is per-merchant setup
  rather than a launch task.

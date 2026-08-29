# Going live

What is left, in the order it has to happen, and who has to do it. Kept in the repository
rather than in a chat because the answer changes as things land, and a checklist nobody can
find is a checklist nobody follows.

**Setting it up rather than reading about it: [`GO-LIVE-fa.md`](GO-LIVE-fa.md)** (Persian) is the
same list as a walkthrough — every command, every variable, and for each one what breaks when it
is missing. This file is the summary; that one is the procedure.

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

Start the API before the watcher, once. The curated asset catalogue is written when the API
starts and only read by the watcher, so on a fresh database a watcher started first has an
approved, listed nothing to look for — it refuses to start and says why, rather than polling
correctly and forever finding nothing. After the first start the order stops mattering.

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

## The short way

```
sudo bash deploy/install.sh --selftest   # generate the files into a temp dir and check them
sudo bash deploy/install.sh --check      # look at the host, change nothing
sudo bash deploy/install.sh              # do it
```

One run covers items 2 through 4 and 9 through 10 below: node, the service user, the checkout and
build, the configuration file, the settlement key placed by the best mechanism that host's systemd
offers, both units, the Caddyfile, the migrations, the preflight, starting the API and *then* the
watcher, and the first admin account. It asks for the database string, `SMTP_URL` and an alert
address; everything else has a default.

It never rewrites a secret, never prints one, and is safe to run again — which makes it the
upgrade path too. `--selftest` builds everything it would write into a temporary directory and
checks it there, including running the generated configuration through the API's own schema.

What it cannot do is item 1 and items 5 through 8: create the database, click through the
dashboard, send a real payment, deploy the contracts. The rest of this file is what the script is
doing and why, which is what you want when something does not work.

## Checking where you are

```
npm run build --workspace @avex/api
npm run preflight --workspace @avex/api
```

Reads the configuration and nothing else — no database, no network, no keys — and reports what
this deployment cannot do. `BLOCKED` is something that stops the product working; `degraded` is a
choice somebody may have made deliberately. It exits 1 on the first, so a pipeline can gate on
it, and 0 on the second.

Every finding it names is a gap that otherwise announces itself as silence, which is why it
exists: no mail server and every message is composed, logged, and never sent, so the signup flow
completes and no merchant can confirm an address.

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

### 4. The first admin account — *operator, one command*

```
npm run admin:bootstrap --workspace @avex/api
```

Asks for an email, a name and a password, and prints an `otpauth://` URI to enrol in an
authenticator. It works only while the staff table is empty, and there is deliberately no HTTP
route that does this — an endpoint that mints a superadmin has to be right about being closed
forever, and not having the endpoint is how you don't have that problem.

Until this command existed, nothing outside a test called `StaffAuthService.bootstrap`, so a
fresh deployment had an admin panel nobody could ever sign in to and nothing anywhere saying so.

The TOTP secret is printed once. Login without a working authenticator returns an enrolment
challenge and no session, so enrolling it is not optional.

### 5. TRON deposit wallets — *needs the operator*

Three to five TRON addresses, registered in the dashboard. **The keys stay with the merchant**;
we only ever hold the addresses. A TRON endpoint goes in `EVM_RPC_URLS` as
`tron=https://api.trongrid.io/jsonrpc` — TRON exposes an Ethereum-compatible JSON-RPC, which is
why it is that variable and not another.

### 6. Testnet, end to end — *both*

An invoice, a real transfer, the watcher crediting it, the webhook arriving, the receipt
rendering. Then the same on a phone, scanning the QR from a real camera, which has never been
done.

**TRON can go live after this.** Note what it means commercially: on TRON the commission is
billed to the merchant's balance rather than taken on chain, so revenue accrues as a receivable
until a chain that can take a cut is live. It is collected from a later EVM invoice, or by
asking.

### 7. The settlement runner — *done, needs a key*

The watcher process now also settles: `startSettlement` builds a signer, a runner and a cycle
per EVM chain, and `SettlementCycle` reads receipts, marks invoices settled, and hands new work
to the queue. It runs only when `SETTLEMENT_KEY_HEX` is set, and says so on every startup when
it is not — a gateway that detects payments and never moves them looks healthy from every angle
except the merchant's balance.

What that leaves for the operator is the key itself, which is item 9.

### 8. Deploy the contracts — *needs the operator*

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

### 9. A settlement key and a gas wallet — *needs the operator*

**What this key can do, precisely.** It cannot move a merchant's money anywhere but to that
merchant. A deposit address is a clone whose payout destination, fee destination and fee rate are
bytes of its own code; `flush` reads them with `EXTCODECOPY` from `address(this)`, takes nothing
from the caller, and is deliberately callable by anyone. The factory cannot redirect it either.
So a stolen key reaches no customer funds and not the fee collector, which is its own address in
every clone.

What it *is* is the **gas wallet**. A thief drains its native balance and can occupy nonces to
keep settlements from confirming until somebody notices. That is the whole loss, and it sets the
proportionate defence: keep the balance to a few days of gas and alarm on it (item 10), and the
exposure is a tank of petrol rather than a merchant's takings.

**Two ways to supply it.**

`SETTLEMENT_KEY_FILE` is the production path — a file the process opens once. Startup refuses
`SETTLEMENT_KEY_HEX` when `NODE_ENV=production`, and the refusal is about the exposure of an
environment variable rather than about the key being in memory: a variable stays in
`/proc/<pid>/environ` for the life of the process, in any core dump, and in the unit or
`EnvironmentFile` that set it. A file is none of those.

Three ways to place that file, best first. Check what the host has with
`systemd-analyze --version` — the numbers matter, and Hetzner's Ubuntu 22.04 images ship 249,
which has only the third.

**systemd ≥ 250 — an encrypted credential.**

```
systemd-creds encrypt --name=settlement-key - /etc/avex/settlement-key.cred
# paste 0x… then ctrl-D. The plaintext never reaches the disk.

# in the unit
LoadCredentialEncrypted=settlement-key:/etc/avex/settlement-key.cred
Environment=SETTLEMENT_KEY_FILE=%d/settlement-key
```

`%d` is `$CREDENTIALS_DIRECTORY`: a tmpfs mounted only inside that unit's namespace, mode 0400,
owned by the service user. Where the host has a TPM the credential is sealed to it; where it has
not — most cloud VMs, Hetzner Cloud included — it is encrypted with a root-only host key, which
still removes the plaintext at rest, the backup copy and the shell history from the picture.

**systemd ≥ 247 — a plain credential.** Same isolation, no encryption at rest:

```
LoadCredential=settlement-key:/etc/avex/settlement-key
Environment=SETTLEMENT_KEY_FILE=/run/credentials/avex-watcher.service/settlement-key
```

**Anything older, or no systemd — just a file.**

```
install -m 600 -o avex -g avex /dev/stdin /etc/avex/settlement-key
# in the unit, or the environment file
SETTLEMENT_KEY_FILE=/etc/avex/settlement-key
```

This is the floor and it is still the right side of the line: the exposure that matters is a
variable readable in `/proc` and copied into every backup of the environment file, and a
`0600` file owned by the service user is neither.

A **KMS** is the stronger thing and is not required here. It never hands the key over at all: it
signs a digest on request, so the key cannot be exfiltrated and access is revocable and logged.
`DerKeyProvider` in `@avex/core` is the seam and does the hard part already — DER parsing,
normalising a high `s`, finding the recovery id, verifying the signature recovers to the expected
address. What is missing is a call to one provider's sign API.

One thing to check before committing to a provider: Ethereum signs on **secp256k1**, and a
managed KMS's default elliptic curve is NIST P-256, which is a different curve and cannot produce
these signatures. secp256k1 is a separate capability that not every provider offers, and where it
is offered it can be restricted to a particular protection level. AWS KMS supports it as the
`ECC_SECG_P256K1` key spec; for anything else, read the provider's list of supported key specs
rather than assuming.

The same wallet pays gas. It needs a balance and an alarm on that balance.

### 10. Operations — *code and operator*

- Alerting: set `OPERATOR_EMAIL`. Critical alerts — a gas wallet running out, a nonce nothing
  can get past, a settlement that reverted — are emailed once per kind per fifteen minutes.
  Warnings stay in the log. Without the address everything is logged and settlement says so at
  startup.
- The gas wallet is checked every settlement pass whether or not there is work, and emails at
  about ten settlements of remaining runway — while topping up is still a calm decision. It used
  to be checked only against the transaction in hand, which meant a wallet draining on a quiet
  chain was never looked at, and the message that arrived in time was a `warning`, which is
  logged rather than emailed. The only email an operator got was the one that meant settlement
  had already stopped.
- A cursor that stops advancing for ten minutes, five failed polls in a row, or a price feed
  suspending is an alert on the same address. The first is the failure nobody reports: a payer's
  transfer confirms, the merchant sees nothing, and each blames the other while every other
  signal looks healthy.
- Database backups with point-in-time recovery. *Operator.*

## Not blockers

- **Solana.** Designed, not implemented — `SolanaAdapter` throws on every method. Nothing
  depends on it, and it is no longer possible to configure a deployment into offering it: it is
  `unique` in the registry but not an EVM chain, so `depositAddressConfig` leaves it out.
- **TON.** `TonAdapter` is a sketch: it polls one address it is never given, credits native TON
  rather than jettons, and has no tests. So no adapter is built for a shared-address chain, and
  the checkout does not offer one — `SHARED_DEPOSIT_WALLETS` is read and then dropped, which
  `preflight` says out loud. Turning TON on means finishing the adapter and adding
  `'shared-memo'` to `CREDITABLE_ADDRESS_MODELS`; `deposit-address-agreement.test.ts` fails until
  both halves are done, which is the point of it.
- **Telegram Stars.** Works, but needs the merchant's own bot, so it is per-merchant setup
  rather than a launch task.

## Known unfinished, and where

Not blockers, and worth naming so they are not rediscovered as surprises.

- **A KMS `KeyProvider` is half-built, and no longer on the critical path.** `DerKeyProvider` in
  `@avex/core` does the hard part — DER parsing, normalising a high `s`, finding the recovery id,
  and verifying the signature recovers to the address the key is supposed to control — and it is
  tested. What is missing is a call to one provider's sign API. It is optional now that
  `SETTLEMENT_KEY_FILE` exists: see item 9 for why a credential file plus a small balance is
  proportionate to what the key actually controls.
- **The QR encoder stops at version 6.** Roughly 106 bytes, against a deposit address of 42 and
  an address-plus-memo of about 57, so nothing the checkout draws comes close. It throws rather
  than truncating if that ever changes.

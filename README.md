# AVEX Pay

Non-custodial crypto payment gateway with Telegram Stars. Merchants accept
stablecoins and native assets; funds move from the payer to the merchant's own
wallet without AVEX ever being able to redirect them.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design and the
reasoning behind it, and [`docs/roadmap.html`](docs/roadmap.html) for the
twelve-phase build plan.

## Layout

```
packages/core     chain adapters, fee policy, settlement, invoice domain
apps/api          platform: identity, organisations, credentials, audit
contracts         Forwarder.sol, and its verification on a real EVM
```

## Supported chains

| Chain | Address model | Settlement cost per invoice | Status |
|---|---|---|---|
| TON | shared address + memo | $0 | adapter written |
| BNB Smart Chain | unique (CREATE2 forwarder) | ~$0.015 | adapter written · **first chain to go live** |
| Polygon | unique (CREATE2 forwarder) | ~$0.015 | adapter written |
| Ethereum | unique (CREATE2 forwarder) | ~$0.014 at 0.05 gwei | adapter written · gated on live gas |
| Solana | unique | ~$0.001 | design settled, not implemented |
| TRON | unique + energy delegation | ~$0.30 | design settled, built last |

Ethereum, Polygon and BNB share one adapter — they differ only in RPC endpoint,
native token price and confirmation depth, all registry entries rather than code.

**Bitcoin is not supported.** It has no equivalent of the Forwarder's immutable
destination, so consolidating deposits would require holding spending keys —
making that one path custodial while every other path is not. Rather than ship a
gateway whose non-custodial claim carries an asterisk, Bitcoin is out of v1.

## Settled product decisions

- **No swapping.** The merchant receives exactly the token the payer sent.
  Conversion requires holding funds, and holding funds is what makes a gateway
  custodial. Merchants enable only the assets they are willing to keep.
- **The merchant pays the network fee.** Settlement cost is deducted and shown
  in full. Absorbing a variable on-chain fee would put unbounded gas risk on
  AVEX's balance sheet.
- **Stars is a separate surface.** Telegram's Bot Platform terms require digital
  goods sold inside Telegram to be paid for in Stars and restrict Mini Apps to
  TON assets. One merchant identity, two checkout paths.

## Quick start

```bash
npm install
docker compose up -d postgres          # or any Postgres 16+
cp .env.example .env

npx tsc -p packages/core/tsconfig.json # core builds first
npx tsc -p apps/api/tsconfig.json

cd apps/api && npx drizzle-kit migrate
npm start
```

## Tests

```bash
# core — no dependencies, runs anywhere
cd packages/core && npm test

# api — unit tests always; the integration suite needs a database
cd apps/api && npm test
cd apps/api && DATABASE_URL=postgres://avex@localhost:5432/avex npm test
```

`packages/core` has no runtime dependencies. Keccak-256 is implemented in-tree
because Node's built-in `sha3-256` uses NIST padding and would silently derive
deposit addresses that no on-chain CREATE2 ever matches; it is verified against
published Keccak, EIP-1014 and EIP-55 vectors.

## The non-custodial guarantee

`Forwarder` takes the merchant's payout address as an immutable constructor
argument. Constructor arguments are part of the init code, and CREATE2 derives
the contract address from a hash of that init code — so the deposit address *is*
a commitment to the destination. There is no admin function, no owner and no
upgrade path. Deployment is deferred: the address is published while no code
exists at it, and the contract is deployed in the same transaction that forwards
the funds.

### Verified by execution, not by argument

The address arithmetic was already checked against the EIP-1014 vectors. What
those cannot check is whether the init code this repository *composes* off-chain
is byte-for-byte what solc and the EVM actually use — and if the two disagree,
every address handed to a payer is one no CREATE2 will ever produce, and the funds
sent there are unreachable.

So `contracts/test/forwarder.test.mjs` compiles the contracts and runs them on an
in-process EVM, asserting that:

- the off-chain derivation equals what `ForwarderFactory.predict` returns
- CREATE2 actually places the contract at that address
- the deployed forwarder's `destination` is the merchant, and changing the
  merchant changes the address — the guarantee, stated as a test
- tokens sent to a published address before any code exists there reach the
  merchant, and nothing is left behind
- a batch settles several invoices in one transaction
- a fee-on-transfer token delivers less than was sent
- native value sent before deployment is swept by the constructor

```bash
cd contracts && npm test
```

It needs no testnet, no key and no funds, so it runs in CI on every commit rather
than once, by hand, before a deploy.

Compiler version and optimizer settings are pinned and recorded in the artifact,
because the deposit address is a hash over this bytecode: recompiling with
different settings changes every address already handed out.

## Security posture

Phase 1 decisions that are already enforced and tested:

- **Only the owner may change a payout address**, not admins. Everything an
  admin can do is recoverable; redirecting revenue is not.
- **Elevated actions require a second factor proven within the last five
  minutes**, and are refused outright for accounts with no authenticator
  enrolled — otherwise elevation would be decorative for exactly the accounts
  least protected.
- **A payout address change is queued with a 24-hour delay**, every member is
  emailed, and *any* member can cancel it — including a viewer. The delay is the
  real protection here: two-factor and role limits raise the cost of getting in,
  but only the delay gives the merchant a chance to notice and undo it, and
  requiring the owner to cancel would leave a compromised owner unstoppable.
  The first address for a chain applies immediately — there is nothing to redirect
  yet, so a delay would obstruct setup without protecting anything.
- **Payout addresses are validated per chain and never overwritten.** A
  replacement supersedes the old row rather than updating it, because "which
  address was active when this invoice settled" gets asked during a dispute.
- **API keys can never hold elevation-gated scopes.** A headless key cannot prove
  possession of an authenticator, so granting it one would create a credential
  that bypasses the requirement.
- **Default-deny routing.** A new route is protected by existing; opening it up
  means adding it to `PUBLIC_ROUTES` on purpose.
- **No secret is stored recoverably.** Passwords are scrypt; session tokens,
  email tokens, API keys and recovery codes are SHA-256 hashes. A database dump
  yields no working credential.
- **Signup does not reveal which emails have accounts.** Duplicate and new
  signups return identical responses; the real owner is emailed instead.

## Pricing

Rates come from several sources at once, combined by median. A single source is
never trusted — not because APIs go down, which is easy to notice, but because an
API returning a *wrong number* is not, and a wrong rate silently under-prices
every invoice until someone reconciles the books.

```ts
const prices = new PriceService(createPriceSources(env.PRICE_SOURCES), config);
await prices.requireRate('ETH');   // throws rather than returning a guess
```

- **Median, not mean.** One source reporting a plausible but wrong price is
  outvoted; a mean would be dragged toward it.
- **Staleness before anything else.** Every observation carries the timestamp the
  source produced it, and the aggregate is only as fresh as its oldest input.
- **A circuit breaker per asset.** Sources disagreeing beyond the dispersion limit
  suspends new quotes for that asset immediately — a data-integrity signal, not a
  flake. Other assets are unaffected. Invoices already open keep their locked rate.
- **No fallback.** `requireRate` throws. Callers that cannot express "no price
  available" must not be handed an invented one.

Which sources are enabled is configuration (`PRICE_SOURCES`), because
reachability varies by deployment — swapping one out must not require a release.
`GET /v1/prices/coverage` reports assets with too few sources to price at all.

### Three pricing modes

| Mode | Amount given in | FX risk |
|---|---|---|
| `fiat` | USD, converted at quote time | Merchant, for the life of the quote |
| `token` | Exact token units | None — nothing is converted |
| `fixed_rate` | USD at a rate the merchant sets | None — for merchant-issued tokens no market prices |

Conversions are integer-only (`pricing/rate.ts`): rates scaled by 1e18, fiat in
micro-dollars. Amounts owed round **up** so a merchant is never short, valuations
round **down** so confirmation tiering never asks for too few confirmations. A
guard rejects assets too coarse-grained to express a price at all — rounding up on
a high-priced token with few decimals would otherwise become a real overcharge.
`fiat` quotes take a configurable protective spread; `fixed_rate` does not, since
the merchant already chose their price.

## The asset catalogue

Merchants can submit their own token contracts. This is necessary, and also the
most direct way an attacker reaches the system: anyone can deploy a contract that
calls itself USDT. Nothing is credited on the strength of what a contract says
about itself.

Approval and enablement are separate decisions. AVEX decides whether a contract
may credit invoices at all; a merchant decides whether they want to accept it.

### What the probe checks

| Check | Catches |
|---|---|
| Code at the address | Wrong address, or a plain wallet |
| `decimals` / `balanceOf` answer | Not a token at all |
| Decimals in range | Values that break amount arithmetic |
| Total supply non-zero | A token nothing could ever be paid with |
| Symbol against the curated list | A contract borrowing a major asset's name |
| EIP-1967 slots and DELEGATECALL | Behaviour that can be replaced after approval |
| Selector scan of bytecode | Issuer powers: pause, freeze, blacklist, mint |
| Simulated transfer | Fee-on-transfer and rebasing |

Transfer behaviour is measured by injecting `contracts/TransferProbe.sol` at an
address that already holds the token, via an `eth_call` state override — `eth_call`
runs without a signature, so nothing is spent and no key is needed. The
measurement has to happen inside one call, because `eth_call` discards state
between calls.

### Two rules that carry the safety

**A check that could not run reports `unknown`, never `absent`.** If the provider
does not support state overrides, or no holder was found, the transfer checks
establish nothing — and `unknown` on anything touching money forces manual review.
Treating silence as safety is how an unvetted contract reaches production.

**Clean checks never add up to approval.** `approved` is reachable only from the
curated list, where each address was verified by hand against the issuer's
documentation. A merchant submission lands in `review` at best; a human decides.

Curated entries carry `issuer_controls` by design — USDT and USDC can both freeze
balances, and refusing them would leave nothing worth accepting. That power is
disclosed to merchants rather than treated as a fault.

### The link back to pricing

An asset no configured source can quote gets `requiresFixedRate`, and the API
refuses to enable it in a market-rate mode — there would be nothing to convert
with. A merchant-set rate must carry an expiry: a fixed rate with no expiry is one
nobody revisits, and a stale one misprices every invoice without ever failing.

A fee-on-transfer token needs its invoice tolerance raised above the observed fee,
or every payment reads as underpaid.

## The watcher

Finds incoming transfers, credits them exactly once, and withdraws credits whose
transactions have left the canonical chain.

The second half is the part that is easy to skip and expensive to omit. A confirmed
transaction can disappear in a reorg; if the credit stays, the merchant has been
paid for a payment that no longer exists and nothing in the system will ever
notice.

- **Idempotent on `chain:txHash:transferIndex`.** Watchers rescan overlapping
  ranges after a restart and providers replay logs, so crediting on every sighting
  pays merchants twice.
- **Reorg detection finds the *deepest* disagreement**, not the shallowest, and
  rewinds to the last block whose hash still verifiably matches. Walking down from
  the tip, the first mismatch found is the shallowest one — rewinding a fixed depth
  below it leaves a deeper fork credited.
- **Block memory is deeper than the rewind depth.** Remembering only as far as the
  rewind would cap detection at that depth, so a fork below it would find no
  remembered block to disagree with.
- **Reversal happens before the cursor moves back.** If the process dies between
  the two, re-scanning a range whose credits are already withdrawn is harmless
  because crediting is idempotent; the opposite order leaves credits standing for
  transactions never revisited.
- **A reorg check runs before every forward scan**, because scanning from a cursor
  sitting on an orphaned block would credit transfers from a chain that no longer
  exists.
- One transfer that fails to credit does not stall the chain behind it, and a
  failed poll is recorded rather than thrown away.

## Webhooks

A merchant learns a payment succeeded through this path, so giving up quietly means
they never ship the goods.

- **Exponential backoff with full jitter.** Without jitter every delivery queued
  during an outage retries at the same instant and knocks the recovering endpoint
  over again.
- **4xx fails immediately; 5xx, timeouts and network errors retry.** A wrong URL or
  a rejected signature is the merchant's configuration, and retrying for hours only
  delays them noticing. 408 and 429 are retried, since both ask to be.
- **Exhausted deliveries are abandoned, not dropped.** A merchant who never
  received a paid callback has a real problem that must be visible to an operator.
- **Every attempt carries the same idempotency key**, so a merchant can discard a
  duplicate they already processed. Retrying is only safe for us if it is also safe
  for them.
- Redirects are not followed — a redirecting endpoint is misconfigured, and
  following one could replay a signed payload to a host that was never authorised.

## Crediting a payment

`DatabasePaymentSink` is where an observed transfer becomes money a merchant is
owed. Two rules shape it.

**A transfer is identified by where it happened** — chain, transaction, position —
and a unique constraint on those three columns enforces it. Re-crediting is
impossible rather than merely unlikely, which matters because watchers rescan
overlapping ranges and providers replay logs.

**`amountPaid` is recomputed from surviving payment rows, never incremented.** A
running total that only rises cannot be corrected when a reorg removes one of its
contributions — and correcting it is precisely what a reversal has to do. A
reversed payment is marked, not deleted: during an incident, "what did we credit
and then take back" is the question being asked.

Webhooks are queued as a database write, never sent inline. A merchant's slow
endpoint must not delay crediting a payment, and a payment must not fail to be
credited because their server is down. Only status *transitions* notify, so a
re-scan that changes nothing does not tell the merchant the same news twice.

## Settlement

Payer funds are protected by the forwarder's immutable destination. The account
that pays *gas* is an ordinary hot key — it cannot redirect anyone's money, but it
can be drained, and if it empties or jams then every settlement stops and funds sit
at their deposit addresses unpaid.

So `SettlementRunner` is mostly limits:

- **A nonce that is never reused and never gapped.** The starting value comes from
  the chain, because guessing zero would collide with every transaction the account
  already sent and each collision is a settlement the mempool silently drops. The
  counter advances only after a successful broadcast — advancing first would leave
  a gap, and everything behind it would sit unmined.
- **A per-transaction cost ceiling**, bounding what a mispriced gas estimate or a
  runaway loop can do to the wallet. Separate from `FeePolicy`, which decides
  whether settling is *economic*; this decides whether it is *safe*.
- **A spend cap per rolling window.**
- **Stuck-transaction replacement** at the same nonce with a higher fee. A
  transaction that never confirms blocks every later nonce, so the pipeline halts
  until it is replaced. The bump must clear the node's minimum increase or the
  replacement is silently discarded and nothing changes.
- **Balance alerting with runway, not a fixed threshold** — warned while there is
  still time to top up, rather than once settlement has already stopped.
- **A reverted settlement is surfaced, never retried.** Gas was spent and nothing
  moved; repeating it usually just burns more.

Signing is delegated to an injected `ChainSigner`, so the key lives in a KMS rather
than in this repository. If a replacement would exceed the cost ceiling, the runner
refuses and alerts instead of bumping — leaving settlement blocked is bad, but
quietly spending past a safety limit is worse, so an operator decides.

## What is not built yet

Phases 5 onward: hosted checkout, merchant dashboard, public API and SDKs,
the Telegram surface, admin panel, remaining chains, hardening. See the roadmap.

The reviewer-facing side of vetting is Phase 9: the probe, verdicts and audit
trail exist, but a reviewer currently changes a verdict in the database rather
than through an admin UI.

A testnet deployment of `ForwarderFactory` is still worth doing before real money
moves, though the address-derivation guarantee no longer rests on it — see the
EVM verification above.

Also outstanding in what exists: native-asset arrival detection on EVM chains
(`poll` covers token transfers only), and a real email transport behind the
`Mailer` interface.

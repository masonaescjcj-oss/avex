# AVEX Pay — architecture and the reasoning behind it

## 1. Non-custodial by construction, not by policy

Funds move payer → merchant. AVEX never holds a balance it could redirect.

On EVM chains this is enforced by arithmetic rather than promised in a document.
`Forwarder` takes its destination as a constructor argument and stores it
`immutable`; constructor arguments are part of the init code, and CREATE2 derives
the contract address from a hash of that init code. So the deposit address
*is* a commitment to the destination. There is no admin function, no owner, and
no upgrade path. Handing a payer address `0xABC…` is a verifiable claim that
anything sent there can only reach one merchant.

This also allows deployment to be deferred: the address is computed and published
while no code exists at it, and the contract is deployed in the same transaction
that forwards the funds.

Why this matters beyond principle:

- **No licence surface.** Holding other people's money converts a software
  company into a financial institution. Not holding it avoids that entirely.
- **Blast radius.** Stablecoins are centrally freezable — USDT and USDC both
  expose a blacklist the issuer can apply to any address, without needing a
  court or jurisdiction. A pooled omnibus balance means one freeze reaches every
  merchant's funds at once. Per-invoice addresses that forward immediately
  compartmentalise that risk to a single invoice.
- **Time to launch.** Weeks instead of quarters.

An off-chain ledger interface is defined but deliberately unimplemented. If a
licensed custodial product is ever wanted, it is a switch rather than a rewrite.

## 2. `ChainAdapter` is the only seam that matters

Everything chain-specific lives behind `src/chains/ChainAdapter.ts`: address
derivation, transfer discovery, fee units, settlement mechanics. Nothing above it
— invoice state machine, fee policy, settlement queue, webhooks — knows which
chain it is talking to.

The payoff is visible already: Ethereum, Polygon and BNB Smart Chain share a
single `EvmAdapter`, differing only by registry entry. Getting this boundary
right on day one is the difference between half a day to add a chain and an
unmaintainable codebase by the fourth one.

## 3. Address model: unique by default, shared only with a native memo

The intuitive rule — unique addresses on cheap chains, shared on expensive ones —
is close but inverted in an important way.

Deriving an address is free on every chain we support. Only *spending* costs, and
we choose when that happens. So expense is not an argument against unique
addresses; it is an argument for deferring settlement.

Meanwhile "shared" only works cleanly where the chain carries a native memo
field. TON, XRP and Stellar do. Ethereum, TRON and Bitcoin — precisely the
expensive ones — do not, leaving amount-matching as the only option, which breaks
as soon as an exchange rounds a withdrawal amount, two payers send similar
amounts concurrently, or a payer rounds by hand.

Hence:

| Model | Chains | Reason |
|---|---|---|
| `shared-memo` | TON | Native comment field. Zero settlement cost — the payer's own transfer reaches the merchant. Strictly better where available. |
| `unique` | Ethereum, Polygon, BNB, TRON, Bitcoin, Solana | Reliable matching. Free to derive. Settlement cost controlled by deferral and batching. |

On TON the tradeoff is that correctness depends on the payer including the memo.
An unmatched transfer is not lost, but it must go to operator reconciliation and
never be credited by guesswork.

## 4. Fees: derive limits from live gas

Ethereum's base fee has structurally collapsed — activity migrated to L2s, and
quiet-period base fees now sit below 0.1 gwei, versus averages above 30 gwei in
2023. At 0.047 gwei a 150,000-gas settlement costs about $0.014, comparable to
BNB Smart Chain.

But the range observed through 2026 spans roughly 0.16 to 9 gwei, and EIP-1559
permits the base fee to rise 12.5% per block — about four minutes from 0.05 to
5 gwei. The problem was never the average; it is the variance.

So no chain gets a static tier. `FeePolicy` computes, from a live `GasSnapshot`:

- `settlementCostUsd` — what it costs *us* to move one invoice's funds, which is
  not the headline transfer fee a comparison site quotes
- `minInvoiceUsd` — `settlementCost / targetFeeRatio`, floored
- `availability` — whether to offer this chain for this invoice at all
- `shouldSettleNow` — whether to settle or keep waiting

For a $20 invoice this offers Ethereum at 0.047 gwei and silently withdraws it at
9 gwei. No operator watches a dashboard; no invoice is accepted that costs more
to settle than it is worth.

Cost is modelled per chain because chains measure work differently — gas units,
sat/vB, energy, lamports — so `SettlementProfile` is a discriminated union rather
than one fake "gas" number.

## 5. Settlement is deferred and batched

`SettlementQueue` holds settlements until the chain is cheap, then batches them.
Safe because funds sit at an address that can only pay their merchant, so
deferring costs nothing but time.

Two bounds keep it honest:

- `maxDeferralMs` — settle regardless once exceeded. Cheap is not worth a broken
  product.
- `maxAttempts` — failed settlements retry, then go to an operator queue rather
  than looping forever.

Batching is where the money is. `ForwarderFactory.settleBatch` deploys and
flushes many forwarders in one transaction; on Bitcoin, consolidating 50 inputs
into one output amortises overhead to near nothing. Combined, deferral and
batching are worth roughly an order of magnitude on the expensive chains.

## 6. Correctness rules that are not negotiable

**Idempotency.** Every observed transfer is keyed `chain:txHash:transferIndex`
and credited at most once. Watchers rescan overlapping ranges after restarts and
RPC providers replay logs; crediting on every sighting pays merchants twice.

**Reversibility.** A confirmed transaction can vanish in a reorg.
`reversePayment` withdraws a credit, so `amountPaid` must be recomputable from
recorded payments rather than treated as a monotonic total.

**Tolerance, not equality.** Exchanges round withdrawals and some tokens take a
fee on transfer. Matching on exact equality rejects payments made in good faith.
Default tolerance is 50 bps; outside it, an invoice becomes `underpaid` or
`overpaid` and waits for a decision instead of settling.

**Contract allowlists.** Only assets in `acceptedAssets` may credit an invoice.
Anyone can deploy a token called USDT.

**Confirmations scaled by value.** A $5 invoice does not need the reorg
protection of a $50,000 one. Polygon PoS stays conservative at 64/128 given its
history of deep reorgs; TRON uses 19, where blocks become irreversible.

**Money is `bigint`.** Smallest units, always. Floating point appears only in fee
heuristics, never in a balance or an amount due.

**Signed webhooks.** HMAC over `timestamp.body`, with a replay window. Signing
only the body would let an attacker replay a genuine `paid` callback forever.

## 7. Telegram Stars is a separate surface, not a chain adapter

Stars cannot be modelled as another `ChainAdapter`, for two reasons.

**Payment always completes inside a Telegram client.** `createInvoiceLink` with
currency `XTR` returns a `t.me/$…` link that can be placed on any website, in an
email, or in a QR code — but clicking it opens Telegram, and there is no API for
debiting a user's Star balance from our own checkout. Payers must hold a Telegram
account and have acquired Stars via Apple/Google IAP, `@PremiumBot`, or Fragment.
Withdrawal requires a 1,000-Star minimum, a 21-day hold on newly earned Stars,
and goes out through Fragment as TON.

**The platform rules conflict with a multi-chain product.** Telegram's Bot
Platform terms require digital goods sold inside Telegram apps to be paid for
exclusively in Stars, and restrict Mini Apps to TON-based assets — promoting or
linking to non-TON cryptoassets is prohibited. A Mini App advertising USDT on
Ethereum or Solana risks being banned, independent of where the company is
incorporated.

So the product splits:

| Surface | Where | Accepts |
|---|---|---|
| AVEX Pay Core | Web / API / SDK | All seven chains |
| AVEX Pay for Telegram | Mini App / Bot | Stars + TON and jettons only |

Shared merchant identity and shared reporting; two separate checkout paths. This
is the only shape that is both a complete product and compliant with the one set
of rules that binds regardless of jurisdiction — Telegram's, enforced by removal
rather than by a regulator.

Fee context worth keeping in view: Stars purchased on mobile carry roughly a 30%
app-store cut, against about 3–4% on desktop. Crypto rails at 0–0.2% are
dramatically cheaper, which is a strong argument for the web checkout — but
inside Telegram, Stars are mandatory regardless.

## 8. Operational realities to design around

These are engineering constraints, not legal commentary.

- **Stablecoin freezes are issuer-side.** USDT and USDC can be frozen by contract
  call, with no jurisdiction required. This argues for per-invoice addresses,
  immediate forwarding, and never pooling merchant funds.
- **RPC access is geofenced.** Major hosted providers block some regions. Run
  own nodes or maintain a fallback pool; adapter code takes `rpcUrl` as
  configuration for exactly this reason.
- **Price oracles are a dependency.** `PriceOracle` is an injected interface;
  every fee decision depends on it, so it needs redundancy and staleness checks.
- **Telegram platform rules apply regardless of incorporation.** Ban is enforced
  by removal from the platform, not by a court.

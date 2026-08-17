# AVEX Pay

Non-custodial crypto payment gateway. Merchants accept stablecoins and native
assets across seven chains; funds move from the payer to the merchant's own
wallet without AVEX ever being able to redirect them.

## Supported chains

| Chain | Address model | Settlement cost per invoice | Status |
|---|---|---|---|
| TON | shared address + memo | $0 | adapter implemented |
| Ethereum | unique (CREATE2 forwarder) | ~$0.014 at 0.05 gwei | adapter implemented |
| Polygon | unique (CREATE2 forwarder) | ~$0.015 | adapter implemented |
| BNB Smart Chain | unique (CREATE2 forwarder) | ~$0.015 | adapter implemented |
| Solana | unique | ~$0.001 | design settled, not implemented |
| TRON | unique + energy delegation | ~$0.30 | design settled, not implemented |
| Bitcoin | unique + batched consolidation | ~$0.10 at 50 inputs | design settled, not implemented |

Ethereum, Polygon and BNB share one adapter — they differ only in RPC endpoint,
native token price and confirmation depth, all of which are registry entries
rather than code.

## Quick start

```bash
npm install
npm run typecheck
npm test
```

No runtime dependencies. Keccak-256 is implemented in-tree
(`src/crypto/keccak256.ts`) and verified against published vectors, because
Node's built-in `sha3-256` uses NIST padding and would silently derive deposit
addresses that no on-chain CREATE2 ever matches.

## Deriving a deposit address

```ts
import { predictForwarder } from 'avex-pay';

const address = predictForwarder(
  { factory: FORWARDER_FACTORY, forwarderCreationCode: FORWARDER_BYTECODE },
  'inv_01H...',
  merchantPayoutAddress,
);
```

The merchant's payout address is a constructor argument to `Forwarder`, so it is
part of the init code that CREATE2 hashes into the address. The address therefore
commits to its destination: there is no admin key, no upgrade path, and no
sequence of calls by which AVEX can send those funds anywhere else. See
`contracts/Forwarder.sol`.

## Fee policy

Minimum invoice sizes are derived from live gas, not hardcoded:

```ts
const policy = new FeePolicy();
const snapshot = await adapter.probeGas();

policy.minInvoiceUsd(snapshot);        // $1.41 at 0.047 gwei, $270 at 9 gwei
policy.shouldSettleNow(snapshot);      // true when cheap, false during a spike
policy.rankForCheckout(snapshots, 20); // cheapest affordable chains, in order
```

This is what keeps Ethereum enabled. A static tier list would either exclude it
permanently or accept $20 invoices that cost $2.70 to settle; the same rule that
allows a $1.50 invoice in a quiet market withdraws Ethereum from checkout during
a spike, with no operator intervention.

## Settlement

`SettlementQueue` holds settlements until the chain is cheap, then batches them.
Deferring is safe because the funds already sit at an address that can only pay
their merchant, so waiting costs nothing but time — bounded by `maxDeferralMs`
so a persistently expensive chain cannot hold merchant funds indefinitely.

The saving is roughly an order of magnitude on Ethereum and Bitcoin. On Bitcoin
specifically, consolidating 50 inputs into one output takes the per-invoice cost
from about $1.50 to about $0.10.

## What is not built yet

- Solana, TRON and Bitcoin adapters (design notes are in each stub file)
- Native-asset arrival detection on EVM chains — `poll` currently covers token
  transfers only
- Persistent `InvoiceStore` (the interface is defined; no implementation)
- HTTP API, merchant dashboard, price oracle implementation
- Telegram Stars integration — see `docs/ARCHITECTURE.md` for why this is a
  separate product surface rather than another chain adapter

## Bitcoin caveat

Bitcoin has no equivalent of the Forwarder's immutable destination, so
consolidation requires spending keys for the deposit addresses. Until those
addresses are derived from the merchant's own xpub with merchant co-signing,
Bitcoin settlement is custodial in a way the EVM and TON paths are not. Do not
describe it as non-custodial to merchants before that is true.

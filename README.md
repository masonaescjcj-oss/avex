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
contracts         Forwarder.sol — the non-custodial guarantee
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

## Security posture

Phase 1 decisions that are already enforced and tested:

- **Only the owner may change a payout address**, not admins. Everything an
  admin can do is recoverable; redirecting revenue is not.
- **Elevated actions require a second factor proven within the last five
  minutes**, and are refused outright for accounts with no authenticator
  enrolled — otherwise elevation would be decorative for exactly the accounts
  least protected.
- **A payout address change is queued with a 24-hour delay**, and every member is
  notified. The delay turns a silent theft into something the merchant can catch.
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

## What is not built yet

Phases 2 onward — pricing engine, asset registry and contract vetting, the
end-to-end payment slice on BNB Chain, hosted checkout, merchant dashboard,
public API and SDKs, the Telegram surface, admin panel, remaining chains,
hardening. See the roadmap.

Also outstanding in what exists: native-asset arrival detection on EVM chains
(`poll` covers token transfers only), and a real email transport behind the
`Mailer` interface.

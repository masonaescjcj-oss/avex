# Design canvas — AVEX Pay on a phone

Twelve screens, drawn from the product as it actually is: the fields the API
accepts, the tabs the dashboard has, and `packages/design/tokens.css` for every
colour. Nothing here shows a feature we do not ship.

| | |
|---|---|
| Auth | `Main` (sign in) · `SignUp` · `CheckEmail` · `Authenticator` · `RecoveryCodes` |
| Merchant | `Overview` · `TakePayment` · `Payouts` · `Security` |
| Buyer | `Invoice` |
| Dark | `SignInDark` · `OverviewDark` |

## Working on it

Every screen is generated — edit `gen.sh`, never the `.dc.html` files.

```bash
bash gen.sh      # rewrite the twelve artboards and canvas.json
node shot.mjs    # render each one to shots/ at 390x844, as the canvas renders it
```

`shot.mjs` needs `playwright-core` (`npm i --no-save playwright-core`) and drives
the Chromium already on the machine. It injects the same reset the canvas runtime
injects (`html,body{height:100%;margin:0}`), so a screen that fits here fits there.

To publish the canvas, seed a fresh copy of the design skill's payload:

```bash
node "$SKILL/seed-canvas.mjs" --template "$SKILL/payload.template.html" \
  --out avex-pay-mobile.html --title "AVEX Pay — Mobile" \
  --artboard Main.dc.html … --canvas canvas.json
```

## What the reference screens have that we do not

The ten screenshots this was drawn against came from a consumer exchange app.
Deliberately absent here, because AVEX has none of it: KYC, staking, markets,
trading, cards, referral codes, promo codes, an AML checker, a PIN, phone login,
social sign-in, a country field, and a six-digit email code (we send a link).

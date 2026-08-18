=== AVEX Pay for WooCommerce ===
Contributors: avex
Tags: woocommerce, payment gateway, crypto, usdt, stablecoin
Requires at least: 6.2
Tested up to: 6.7
Requires PHP: 8.0
Stable tag: 1.0.0
License: MIT

Accept USDT, USDC, TON, ETH, BNB, SOL, TRX and POL. Funds settle straight to your own
wallet — AVEX never holds them.

== Description ==

Your customer picks the coin and network on a hosted page; you get a webhook when the
payment is final. Funds go from the customer's transfer to your own wallet address, which
means AVEX cannot hold, freeze or redirect them — the deposit address is derived so that it
can only ever pay the address you configured.

* USDT and USDC on TON, TRON, BNB Chain, Ethereum, Polygon and Solana
* Native TON, ETH, BNB, SOL, TRX and POL
* 0.5% commission and no monthly fee, taken out of the payment on chain
* Absorb that commission or pass it to the customer — your choice, set in AVEX
* A test mode that needs no faucet and no testnet

== Installation ==

1. Upload the plugin and activate it.
2. In AVEX, create an API key with the `invoice:create` permission. Use an `ak_test_` key
   first — nothing it does can move real money.
3. In AVEX, add a webhook endpoint pointing at
   `https://your-store.example/?wc-api=avex_pay` and copy its secret. The secret is shown
   once.
4. In **WooCommerce → Settings → Payments → AVEX Pay**, paste the organisation id, the API
   key and the webhook secret.
5. Add a payout address for every chain you want to accept, in AVEX. Funds can only move
   to an address you configured, so an invoice on a chain with no payout address is
   refused.

The gateway will not appear at checkout until all four settings are filled in. That is
deliberate: a gateway missing its webhook secret would take payments and never complete an
order, so the customer pays and waits while you see nothing.

== Frequently Asked Questions ==

= How do I test without spending anything? =

Configure an `ak_test_` key. Orders placed with it create test invoices, whose deposit
addresses are not valid on any chain — nothing can be sent to them by accident. Pay them
from the AVEX API with `simulate-payment`, and your webhook handler runs exactly as it
would for a real payment. Test volume never appears in your reports and never counts
towards your commission tier.

= What does it cost? =

0.5% of what you process, and nothing else — no monthly fee, no minimum, and nothing to
pay in a month you took no orders. It is deducted from the payment on chain, in the same
transaction that settles to your wallet, so there is never an invoice from AVEX to pay.
Above $50,000 a month the rate is 0.45%, above $250,000 it is 0.4%.

= Can I charge the commission to the customer instead? =

Yes, in AVEX under Commission → Who pays it. On a $100 order, absorbing it means the
customer sends $100 and you receive $99.50; passing it on means they send $100.50 and you
receive $100. Either way AVEX receives the same, so it is your pricing decision. When you
pass it on, the checkout page shows the customer the fee as its own line — a customer
charged more than your price and not told why has been overcharged as far as they can tell.

The setting lives in AVEX rather than in this plugin on purpose: one place to set it means
the amount your customer is shown and the amount your order records cannot disagree.

= Can a customer mark their own order paid? =

No. Only a signed webhook completes an order. The page a customer returns to after paying
shows a message and nothing more — it never changes an order's status, because that URL is
one anybody can visit.

= What happens if they pay too little? =

The order goes on hold with the shortfall recorded, and the customer can send the
difference to the same address. It is not failed, because real money arrived and telling
you otherwise would be wrong.

= What happens if they pay too much? =

On hold, with a note asking you to refund the difference before shipping. The order is
covered, so nothing is at risk — but somebody has to make that refund, and completing
silently would hide it.

= What if a payment arrives after the invoice expired? =

On hold, not failed. A late payer is not an absent one, and the funds are real.

== Changelog ==

= 1.0.0 =
* First release.

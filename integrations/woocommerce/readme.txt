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
* Free below $1,500 of monthly volume
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
towards your bill.

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

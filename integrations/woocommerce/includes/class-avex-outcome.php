<?php
/**
 * What a webhook means for an order.
 *
 * Separated from WooCommerce and tested on its own because this is where payment plugins
 * go wrong, and they go wrong in the same two ways every time.
 *
 * The first is trusting the customer's return trip. `successUrl` is a URL a customer can
 * simply visit — nothing stops them typing it — so a plugin that completes an order when
 * someone lands on it gives goods away for free. Only a signed webhook may complete an
 * order, which is why there is no branch here for a browser redirect.
 *
 * The second is reading `status` and ignoring the amount. An invoice can be `paid`
 * within tolerance and still be a few units short, and an `underpaid` one has real money
 * against it that a merchant needs to see rather than have silently discarded.
 *
 * @package AvexPay
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) && ! defined( 'AVEX_PAY_TESTING' ) ) {
	exit;
}

/**
 * Turns an invoice payload into the one thing to do with an order.
 */
final class Avex_Outcome {

	const ACTION_COMPLETE  = 'complete';
	const ACTION_ON_HOLD   = 'on-hold';
	const ACTION_PENDING   = 'pending';
	const ACTION_FAILED    = 'failed';
	const ACTION_IGNORE    = 'ignore';

	/**
	 * Decide what an invoice payload means.
	 *
	 * @param array  $invoice    Invoice object from the webhook payload.
	 * @param string $order_mode Mode the order was created in: `test` or `live`.
	 * @return array{action: string, note: string}
	 */
	public static function decide( array $invoice, string $order_mode ): array {
		$status = isset( $invoice['status'] ) ? (string) $invoice['status'] : '';
		$mode   = isset( $invoice['mode'] ) ? (string) $invoice['mode'] : 'live';

		/**
		 * Mode must match, and a mismatch is ignored rather than acted on.
		 *
		 * A live order completed by a test invoice is a free order — and a merchant who
		 * left a test key in one place and a live key in another would otherwise ship
		 * goods against a simulated payment. Ignoring is the only safe answer, because
		 * neither completing nor failing the order is correct.
		 */
		if ( $mode !== $order_mode ) {
			return array(
				'action' => self::ACTION_IGNORE,
				'note'   => sprintf(
					/* translators: 1: invoice mode, 2: order mode */
					'Ignored an AVEX webhook in %1$s mode for an order placed in %2$s mode.',
					$mode,
					$order_mode
				),
			);
		}

		$due  = self::to_int( $invoice['amountDue'] ?? '0' );
		$paid = self::to_int( $invoice['amountPaid'] ?? '0' );

		switch ( $status ) {
			case 'paid':
				/**
				 * Trust the gateway's tolerance, but state the shortfall.
				 *
				 * The tolerance exists because exchanges round withdrawal amounts, and
				 * refusing a payment four units short would lose real sales. So `paid`
				 * completes the order — and the note records the exact figures, because
				 * "the gateway said so" is not something a merchant can reconcile against
				 * three months later.
				 */
				return array(
					'action' => self::ACTION_COMPLETE,
					'note'   => sprintf(
						'AVEX payment confirmed. Received %1$s of %2$s (smallest units) on %3$s.',
						$paid,
						$due,
						isset( $invoice['chain'] ) ? (string) $invoice['chain'] : 'chain'
					),
				);

			case 'overpaid':
				/**
				 * On hold, not complete.
				 *
				 * The order is covered, so nothing is at risk — but the customer is owed
				 * the difference, and completing silently would hide a refund somebody
				 * has to make. A human should see this one.
				 */
				return array(
					'action' => self::ACTION_ON_HOLD,
					'note'   => sprintf(
						'AVEX payment received but overpaid: %1$s against %2$s due. Refund the difference before shipping.',
						$paid,
						$due
					),
				);

			case 'underpaid':
				/**
				 * On hold with the shortfall named, rather than failed.
				 *
				 * There is real money against this order. Failing it would suggest to the
				 * merchant that nothing arrived, and the customer can still make it up by
				 * sending the difference to the same address.
				 */
				return array(
					'action' => self::ACTION_ON_HOLD,
					'note'   => sprintf(
						'AVEX payment short by %1$s smallest units (%2$s of %3$s). The customer can send the difference to the same address.',
						max( 0, $due - $paid ),
						$paid,
						$due
					),
				);

			case 'confirming':
				return array(
					'action' => self::ACTION_PENDING,
					'note'   => 'AVEX has seen the transfer and is waiting for confirmations.',
				);

			case 'expired':
				/**
				 * Failed only if nothing arrived.
				 *
				 * An expired invoice with money against it is not a failure — the payer
				 * was late, not absent, and the funds are real. Failing it would tell the
				 * merchant to forget an order they have been paid for.
				 */
				if ( $paid > 0 ) {
					return array(
						'action' => self::ACTION_ON_HOLD,
						'note'   => sprintf(
							'AVEX invoice expired, but %1$s smallest units arrived. Check before cancelling.',
							$paid
						),
					);
				}
				return array(
					'action' => self::ACTION_FAILED,
					'note'   => 'The AVEX payment window closed with nothing received.',
				);

			case 'pending':
				return array(
					'action' => self::ACTION_PENDING,
					'note'   => 'Waiting for the customer to pay.',
				);

			default:
				/**
				 * An unknown status is ignored, not guessed at.
				 *
				 * A future status this plugin has never heard of must not fall through to
				 * "complete" or "failed". Leaving the order alone is always recoverable;
				 * shipping against a status we misread is not.
				 */
				return array(
					'action' => self::ACTION_IGNORE,
					'note'   => sprintf( 'Unrecognised AVEX invoice status: %s. No change made.', $status ),
				);
		}
	}

	/**
	 * A smallest-unit amount as an integer.
	 *
	 * These arrive as strings because eighteen decimals does not fit in a double. PHP
	 * integers are 64-bit, which holds any realistic token amount but not every possible
	 * one — so a value too large is clamped to PHP_INT_MAX rather than silently becoming
	 * a float and losing precision in a comparison that decides whether to ship goods.
	 *
	 * @param mixed $value Amount as a decimal string.
	 * @return int
	 */
	private static function to_int( $value ): int {
		$text = trim( (string) $value );
		if ( '' === $text || ! preg_match( '/^\d+$/', $text ) ) {
			return 0;
		}
		if ( strlen( $text ) > 18 ) {
			// Comparisons stay meaningful: both sides clamp the same way, so an
			// enormous amountPaid still reads as at least the amountDue.
			return PHP_INT_MAX;
		}
		return (int) $text;
	}
}

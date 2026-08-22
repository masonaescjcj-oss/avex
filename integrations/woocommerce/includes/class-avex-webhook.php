<?php
/**
 * The webhook receiver.
 *
 * The only place an order is ever marked paid.
 *
 * That is worth stating as the file's purpose, because the tempting alternative is to
 * complete the order when the customer returns from paying — and `successUrl` is a URL a
 * customer can simply type. A plugin that trusts the return trip gives goods away to
 * anyone who visits it. WooCommerce's own return handler here does nothing but show an
 * accurate message.
 *
 * @package AvexPay
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Verifies a delivery and applies it to an order.
 */
final class Avex_Webhook {

	/**
	 * Register the endpoint.
	 */
	public static function init(): void {
		add_action( 'woocommerce_api_avex_pay', array( __CLASS__, 'handle' ) );
	}

	/**
	 * Handle one delivery.
	 */
	public static function handle(): void {
		/**
		 * The raw body, not the parsed one.
		 *
		 * The signature covers the bytes AVEX sent. Re-encoding a parsed array produces
		 * different bytes — key order, unicode escaping, float formatting — and the
		 * signature would never match. `php://input` is the only correct source.
		 */
		$body = (string) file_get_contents( 'php://input' );

		$settings = get_option( 'woocommerce_avex_pay_settings', array() );
		$secret   = is_array( $settings ) && isset( $settings['webhook_secret'] )
			? (string) $settings['webhook_secret']
			: '';

		$header = isset( $_SERVER['HTTP_AVEX_SIGNATURE'] )
			? sanitize_text_field( wp_unslash( (string) $_SERVER['HTTP_AVEX_SIGNATURE'] ) )
			: '';

		$check = Avex_Signature::verify( $header, $body, $secret );
		if ( ! $check['valid'] ) {
			/**
			 * 400 with nothing useful in it.
			 *
			 * The reason goes to the log, not to the caller: telling an unauthenticated
			 * sender whether they got the timestamp or the digest wrong helps only them.
			 */
			self::log( 'rejected a delivery: ' . $check['reason'] );
			status_header( 400 );
			wp_send_json( array( 'error' => 'invalid_signature' ), 400 );
			return;
		}

		/**
		 * The payload is flat: `invoiceId`, `reference`, `mode`, `status`, `amountDue`,
		 * `amountPaid`, `chain`, `txHash`.
		 *
		 * Matched to what AVEX actually sends rather than to a shape that seemed tidier.
		 * The first version of this file read `payload.invoice.*`, which would have made
		 * every field absent — and an absent `mode` reads as `live`, so a test invoice
		 * would have completed a live order. Leniency about shape hides exactly that.
		 */
		$invoice = json_decode( $body, true );
		if ( ! is_array( $invoice ) || ! isset( $invoice['invoiceId'], $invoice['status'] ) ) {
			status_header( 400 );
			wp_send_json( array( 'error' => 'malformed_payload' ), 400 );
			return;
		}

		$order = self::find_order( $invoice );

		if ( ! $order ) {
			/**
			 * 200, not 404.
			 *
			 * A delivery for an order this site does not have is not a failure AVEX should
			 * retry — most likely it belongs to another site sharing the endpoint, or an
			 * order that was deleted. Answering 404 would make AVEX retry it for hours and
			 * eventually disable the endpoint, taking the working deliveries with it.
			 */
			self::log( 'no local order for the delivery; acknowledging anyway' );
			wp_send_json( array( 'status' => 'ignored' ), 200 );
			return;
		}

		$order_mode = (string) $order->get_meta( '_avex_mode' );
		if ( '' === $order_mode ) {
			$order_mode = 'live';
		}

		$outcome = Avex_Outcome::decide( $invoice, $order_mode );
		self::apply( $order, $outcome );

		wp_send_json( array( 'status' => 'ok', 'action' => $outcome['action'] ), 200 );
	}

	/**
	 * The order a delivery belongs to.
	 *
	 * Matched on the reference the plugin set when opening the checkout, which is the
	 * order id. Falls back to the checkout id stored in meta, for a delivery whose
	 * reference has been changed by hand.
	 *
	 * @param array $invoice Invoice payload.
	 * @return WC_Order|null
	 */
	private static function find_order( array $invoice ) {
		$reference = isset( $invoice['reference'] ) ? (string) $invoice['reference'] : '';
		if ( str_starts_with( $reference, 'wc-' ) ) {
			$order = wc_get_order( (int) substr( $reference, 3 ) );
			if ( $order ) {
				return $order;
			}
		}

		/**
		 * A hosted checkout sets the reference itself, as `chk_<session>_<asset>`.
		 *
		 * So an order paid through the hosted page does not carry `wc-<id>` — it is
		 * found through the checkout id stored on the order when the payment started.
		 */
		if ( str_starts_with( $reference, 'chk_' ) ) {
			$session = explode( '_', $reference );
			if ( isset( $session[1] ) ) {
				$orders = wc_get_orders(
					array(
						'limit'      => 1,
						'meta_key'   => '_avex_checkout_id',
						'meta_value' => $session[1],
					)
				);
				if ( ! empty( $orders ) ) {
					return $orders[0];
				}
			}
		}

		return null;
	}

	/**
	 * Apply an outcome to an order.
	 *
	 * @param WC_Order $order   The order.
	 * @param array    $outcome From Avex_Outcome::decide.
	 */
	private static function apply( $order, array $outcome ): void {
		/**
		 * An order already paid is left alone.
		 *
		 * Deliveries retry, and a duplicate must not move a shipped order back to
		 * on-hold or fire the completion hooks a second time — a merchant whose
		 * fulfilment runs on `woocommerce_order_status_completed` would ship twice.
		 */
		if ( $order->is_paid() && Avex_Outcome::ACTION_COMPLETE === $outcome['action'] ) {
			return;
		}

		switch ( $outcome['action'] ) {
			case Avex_Outcome::ACTION_COMPLETE:
				$order->add_order_note( $outcome['note'] );
				// `payment_complete` rather than a status change: it is what decrements
				// stock, records the paid date and fires the hooks a store's fulfilment
				// is hung off.
				$order->payment_complete();
				break;

			case Avex_Outcome::ACTION_ON_HOLD:
				$order->update_status( 'on-hold', $outcome['note'] );
				break;

			case Avex_Outcome::ACTION_FAILED:
				$order->update_status( 'failed', $outcome['note'] );
				break;

			case Avex_Outcome::ACTION_PENDING:
				// A note without a status change: the order is already pending, and
				// re-setting it would clutter the history on every confirmation.
				$order->add_order_note( $outcome['note'] );
				break;

			case Avex_Outcome::ACTION_IGNORE:
			default:
				// Noted, never acted on. An unknown status or a mode mismatch is
				// something a human should see rather than something to guess at.
				$order->add_order_note( $outcome['note'] );
				break;
		}
	}

	/**
	 * Log through WooCommerce, so it lands where a merchant already looks.
	 *
	 * @param string $message Message.
	 */
	private static function log( string $message ): void {
		if ( function_exists( 'wc_get_logger' ) ) {
			wc_get_logger()->warning( $message, array( 'source' => 'avex-pay-for-woocommerce' ) );
		}
	}
}

<?php
/**
 * HTTP client for the AVEX Pay API.
 *
 * Uses `wp_remote_post` rather than cURL directly, so a site's own HTTP filters, proxy
 * settings and timeouts apply — a plugin that reaches past the platform's HTTP layer is a
 * plugin that breaks on the one host that needs a proxy.
 *
 * @package AvexPay
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) && ! defined( 'AVEX_PAY_TESTING' ) ) {
	exit;
}

/**
 * Thin wrapper over the two calls this plugin makes.
 */
final class Avex_Client {

	/**
	 * API base, without a trailing slash.
	 *
	 * @var string
	 */
	private $base;

	/**
	 * Organisation id.
	 *
	 * @var string
	 */
	private $organization;

	/**
	 * API key. Never logged.
	 *
	 * @var string
	 */
	private $key;

	/**
	 * @param string $base         API base URL.
	 * @param string $organization Organisation id.
	 * @param string $key          API key.
	 */
	public function __construct( string $base, string $organization, string $key ) {
		$this->base         = rtrim( $base, '/' );
		$this->organization = $organization;
		$this->key          = $key;
	}

	/**
	 * Open a checkout for an order.
	 *
	 * The order id is sent as `reference`, which makes this idempotent for free: a
	 * customer who reloads the payment page, or a checkout that times out and retries,
	 * gets the same AVEX checkout back rather than a second payment link for one order.
	 *
	 * @param int    $order_id    WooCommerce order id.
	 * @param string $amount      Order total, as a decimal string in the store currency.
	 * @param string $description Shown to the customer.
	 * @param string $success_url Where to send them afterwards.
	 * @param string $cancel_url  Where to send them if they give up.
	 * @return array{ok: bool, url: string, id: string, error: string}
	 */
	public function create_checkout(
		int $order_id,
		string $amount,
		string $description,
		string $success_url,
		string $cancel_url
	): array {
		$response = wp_remote_post(
			$this->base . '/v1/organizations/' . rawurlencode( $this->organization ) . '/checkouts',
			array(
				'timeout' => 20,
				'headers' => array(
					'Authorization' => 'Bearer ' . $this->key,
					'Content-Type'  => 'application/json',
				),
				'body'    => (string) wp_json_encode(
					array(
						// Micro-dollars: the API takes integers in strings, because a
						// float would round an amount somebody is owed.
						'amountFiatMicros' => self::to_micros( $amount ),
						'reference'        => 'wc-' . $order_id,
						'description'      => $description,
						'successUrl'       => $success_url,
						'cancelUrl'        => $cancel_url,
					)
				),
			)
		);

		if ( is_wp_error( $response ) ) {
			return array(
				'ok'    => false,
				'url'   => '',
				'id'    => '',
				'error' => $response->get_error_message(),
			);
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$body   = json_decode( (string) wp_remote_retrieve_body( $response ), true );

		/**
		 * 200 as well as 201.
		 *
		 * A repeat of the same reference answers 200 with the existing checkout, and that
		 * is a success — treating it as an error would break exactly the retry the
		 * reference exists to make safe.
		 */
		if ( 200 !== $status && 201 !== $status ) {
			return array(
				'ok'    => false,
				'url'   => '',
				'id'    => '',
				'error' => is_array( $body ) && isset( $body['message'] )
					? (string) $body['message']
					/* translators: %d: HTTP status code */
					: sprintf( 'AVEX returned HTTP %d.', $status ),
			);
		}

		return array(
			'ok'    => true,
			'url'   => is_array( $body ) && isset( $body['url'] ) ? (string) $body['url'] : '',
			'id'    => is_array( $body ) && isset( $body['id'] ) ? (string) $body['id'] : '',
			'error' => '',
		);
	}

	/**
	 * Read a checkout back, for the return trip.
	 *
	 * Used to show the customer an accurate message when they come back from paying —
	 * never to complete the order. Only a signed webhook does that.
	 *
	 * @param string $session_id Checkout id.
	 * @return array|null
	 */
	public function get_checkout( string $session_id ): ?array {
		$response = wp_remote_get(
			$this->base . '/v1/organizations/' . rawurlencode( $this->organization )
				. '/checkouts/' . rawurlencode( $session_id ),
			array(
				'timeout' => 15,
				'headers' => array( 'Authorization' => 'Bearer ' . $this->key ),
			)
		);

		if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return null;
		}

		$body = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		return is_array( $body ) ? $body : null;
	}

	/**
	 * A decimal amount as micro-dollars, without touching a float.
	 *
	 * `(int) round( $amount * 1000000 )` is the obvious version and it is wrong: binary
	 * floating point cannot hold 19.99 exactly, so a store selling at that price would
	 * invoice a cent out often enough to matter. Splitting the string keeps every digit.
	 *
	 * @param string $amount Decimal amount, e.g. "19.99".
	 * @return string
	 */
	public static function to_micros( string $amount ): string {
		$text = trim( $amount );
		$sign = '';
		if ( str_starts_with( $text, '-' ) ) {
			// Negative totals are not payable; the caller refuses them. Preserved rather
			// than swallowed so a bug upstream surfaces as an API rejection.
			$sign = '-';
			$text = substr( $text, 1 );
		}

		$parts    = explode( '.', $text, 2 );
		$whole    = '' === $parts[0] ? '0' : preg_replace( '/\D/', '', $parts[0] );
		$fraction = isset( $parts[1] ) ? preg_replace( '/\D/', '', $parts[1] ) : '';

		// Six digits exactly: pad a short fraction, truncate a long one. Truncating is
		// the right direction — inventing precision would overcharge.
		$fraction = substr( str_pad( (string) $fraction, 6, '0' ), 0, 6 );

		$digits = ltrim( (string) $whole . $fraction, '0' );
		if ( '' === $digits ) {
			// Zero has no sign. Returning '-' for a zero total would be a body the API
			// rejects for a reason nobody could work out from the message.
			return '0';
		}

		return $sign . $digits;
	}
}

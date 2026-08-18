<?php
/**
 * The WooCommerce payment gateway.
 *
 * @package AvexPay
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Sends the customer to an AVEX checkout and waits for the webhook.
 */
final class Avex_Gateway extends WC_Payment_Gateway {

	/**
	 * Set up the gateway.
	 */
	public function __construct() {
		$this->id                 = 'avex_pay';
		$this->method_title       = __( 'AVEX Pay', 'avex-pay' );
		$this->method_description = __(
			'Accept USDT, USDC, TON, ETH, BNB, SOL, TRX and POL. Funds settle straight to your own wallet — AVEX never holds them.',
			'avex-pay'
		);
		$this->has_fields = false;
		$this->supports   = array( 'products' );

		$this->init_form_fields();
		$this->init_settings();

		$this->title       = $this->get_option( 'title' );
		$this->description = $this->get_option( 'description' );
		$this->enabled     = $this->get_option( 'enabled' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
	}

	/**
	 * Settings shown in WooCommerce.
	 */
	public function init_form_fields(): void {
		$this->form_fields = array(
			'enabled'      => array(
				'title'   => __( 'Enable', 'avex-pay' ),
				'type'    => 'checkbox',
				'label'   => __( 'Accept crypto through AVEX Pay', 'avex-pay' ),
				'default' => 'no',
			),
			'title'        => array(
				'title'       => __( 'Title', 'avex-pay' ),
				'type'        => 'text',
				'description' => __( 'What the customer sees at checkout.', 'avex-pay' ),
				'default'     => __( 'Pay with crypto', 'avex-pay' ),
				'desc_tip'    => true,
			),
			'description'  => array(
				'title'   => __( 'Description', 'avex-pay' ),
				'type'    => 'textarea',
				'default' => __( 'Pay in USDT, TON, ETH and more. You choose the coin and network on the next page.', 'avex-pay' ),
			),
			'api_base'     => array(
				'title'       => __( 'API base URL', 'avex-pay' ),
				'type'        => 'text',
				'default'     => 'https://api.avex.example',
				'description' => __( 'Leave as provided unless AVEX told you otherwise.', 'avex-pay' ),
				'desc_tip'    => true,
			),
			'organization' => array(
				'title'       => __( 'Organisation ID', 'avex-pay' ),
				'type'        => 'text',
				'description' => __( 'From your AVEX dashboard.', 'avex-pay' ),
				'desc_tip'    => true,
			),
			'api_key'      => array(
				'title'       => __( 'API key', 'avex-pay' ),
				'type'        => 'password',
				'description' => __(
					'A key with the invoice:create permission. Use an ak_test_ key while you are setting up — nothing will move real money.',
					'avex-pay'
				),
				'desc_tip'    => true,
			),
			'webhook_secret' => array(
				'title'       => __( 'Webhook secret', 'avex-pay' ),
				'type'        => 'password',
				'description' => sprintf(
					/* translators: %s: the webhook URL to register */
					__( 'Create an endpoint in AVEX pointing at %s and paste its secret here. Without it, no order will ever be marked paid.', 'avex-pay' ),
					esc_url( self::webhook_url() )
				),
			),
		);
	}

	/**
	 * Where AVEX should send deliveries.
	 *
	 * A WooCommerce API endpoint rather than a page, so it works whatever the site's
	 * permalink settings are — a plugin that needs pretty permalinks fails silently on
	 * the sites that do not have them.
	 */
	public static function webhook_url(): string {
		return add_query_arg( 'wc-api', 'avex_pay', trailingslashit( home_url() ) );
	}

	/**
	 * Whether this gateway is configured well enough to offer.
	 *
	 * A gateway missing its webhook secret is worse than one that is switched off: it
	 * takes payments and then never completes an order, so the customer pays and waits
	 * while the merchant sees nothing.
	 */
	public function is_available(): bool {
		if ( 'yes' !== $this->enabled ) {
			return false;
		}
		foreach ( array( 'api_base', 'organization', 'api_key', 'webhook_secret' ) as $required ) {
			if ( '' === trim( (string) $this->get_option( $required ) ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Open a checkout and send the customer to it.
	 *
	 * @param int $order_id Order id.
	 * @return array
	 */
	public function process_payment( $order_id ): array {
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			return array( 'result' => 'failure' );
		}

		$client = new Avex_Client(
			(string) $this->get_option( 'api_base' ),
			(string) $this->get_option( 'organization' ),
			(string) $this->get_option( 'api_key' )
		);

		$checkout = $client->create_checkout(
			(int) $order_id,
			(string) $order->get_total(),
			sprintf(
				/* translators: 1: order number, 2: site name */
				__( 'Order %1$s at %2$s', 'avex-pay' ),
				$order->get_order_number(),
				get_bloginfo( 'name' )
			),
			$this->get_return_url( $order ),
			$order->get_cancel_order_url()
		);

		if ( ! $checkout['ok'] || '' === $checkout['url'] ) {
			/**
			 * The reason is shown to the customer as well as noted on the order.
			 *
			 * AVEX's refusals are written for a merchant to act on — "add a payout address
			 * for bsc", "your subscription is overdue" — so passing the message through is
			 * more useful than a generic failure, and it reaches whoever is testing.
			 */
			$order->add_order_note(
				sprintf(
					/* translators: %s: error message from AVEX */
					__( 'AVEX Pay could not open a checkout: %s', 'avex-pay' ),
					$checkout['error']
				)
			);
			wc_add_notice(
				__( 'We could not start the crypto payment. Please try again or choose another method.', 'avex-pay' ),
				'error'
			);
			return array( 'result' => 'failure' );
		}

		/**
		 * Record the mode the order was placed in.
		 *
		 * Read back when a webhook arrives, so a test invoice can never complete a live
		 * order. Taken from the key's own prefix rather than from a setting, because the
		 * key is what actually decides.
		 */
		$order->update_meta_data( '_avex_checkout_id', $checkout['id'] );
		$order->update_meta_data( '_avex_mode', $this->key_mode() );
		$order->update_status( 'pending', __( 'Waiting for the AVEX Pay checkout.', 'avex-pay' ) );
		$order->save();

		return array(
			'result'   => 'success',
			'redirect' => $checkout['url'],
		);
	}

	/**
	 * The mode implied by the configured key.
	 *
	 * From the prefix, because that is what the API enforces: an `ak_test_` key cannot
	 * create a live object however the request is phrased.
	 */
	private function key_mode(): string {
		return str_starts_with( (string) $this->get_option( 'api_key' ), 'ak_test_' ) ? 'test' : 'live';
	}
}

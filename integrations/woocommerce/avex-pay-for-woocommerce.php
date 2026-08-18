<?php
/**
 * Plugin Name:       AVEX Pay for WooCommerce
 * Plugin URI:        https://avex.example/docs
 * Description:       Accept USDT, USDC, TON, ETH, BNB, SOL, TRX and POL. Funds settle straight to your own wallet — AVEX never holds them.
 * Version:           1.0.0
 * Requires at least: 6.2
 * Requires PHP:      8.0
 * Author:            AVEX
 * License:           MIT
 * Text Domain:       avex-pay
 *
 * WC requires at least: 8.0
 * WC tested up to:      9.4
 *
 * @package AvexPay
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'AVEX_PAY_VERSION', '1.0.0' );
define( 'AVEX_PAY_PATH', plugin_dir_path( __FILE__ ) );

/**
 * Declare compatibility with High-Performance Order Storage.
 *
 * Without this WooCommerce refuses to enable HPOS on a site running this plugin, which
 * makes us the reason a merchant cannot take a performance feature. The plugin reads
 * orders only through `wc_get_order` and `wc_get_orders`, so the declaration is true.
 */
add_action(
	'before_woocommerce_init',
	static function (): void {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
				'custom_order_tables',
				__FILE__,
				true
			);
		}
	}
);

add_action(
	'plugins_loaded',
	static function (): void {
		/**
		 * Nothing loads without WooCommerce.
		 *
		 * A gateway class extending a class that does not exist is a fatal error, which
		 * would take the whole site down rather than showing a notice — so the check comes
		 * before the require, not inside it.
		 */
		if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
			add_action(
				'admin_notices',
				static function (): void {
					echo '<div class="notice notice-warning"><p>'
						. esc_html__( 'AVEX Pay needs WooCommerce to be active.', 'avex-pay' )
						. '</p></div>';
				}
			);
			return;
		}

		require_once AVEX_PAY_PATH . 'includes/class-avex-signature.php';
		require_once AVEX_PAY_PATH . 'includes/class-avex-outcome.php';
		require_once AVEX_PAY_PATH . 'includes/class-avex-client.php';
		require_once AVEX_PAY_PATH . 'includes/class-avex-gateway.php';
		require_once AVEX_PAY_PATH . 'includes/class-avex-webhook.php';

		Avex_Webhook::init();

		add_filter(
			'woocommerce_payment_gateways',
			static function ( array $gateways ): array {
				$gateways[] = 'Avex_Gateway';
				return $gateways;
			}
		);
	}
);

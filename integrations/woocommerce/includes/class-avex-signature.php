<?php
/**
 * Webhook signature verification.
 *
 * Deliberately free of WordPress and WooCommerce, for two reasons. It is the only
 * security-critical code in this plugin, so it has to be testable without standing up a
 * WordPress install — and a plugin whose signature check has never been run is a plugin
 * whose signature check does not work.
 *
 * @package AvexPay
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) && ! defined( 'AVEX_PAY_TESTING' ) ) {
	exit;
}

/**
 * Verifies the `avex-signature` header AVEX sends with every delivery.
 *
 * The header is `t=<unix seconds>,v1=<hex hmac>`, and the signed message is
 * `<timestamp>.<raw body>`. The timestamp is inside the signature rather than beside it,
 * so an attacker cannot replay yesterday's "paid" notification with a fresh timestamp —
 * changing it invalidates the digest.
 */
final class Avex_Signature {

	/**
	 * How far out of date a delivery may be, in seconds.
	 *
	 * Five minutes. Long enough for a slow queue or a clock a little adrift; short
	 * enough that a captured request stops being useful before anyone can use it. A
	 * signature check with no window is not a replay defence at all.
	 */
	const TOLERANCE_SECONDS = 300;

	/**
	 * Whether a delivery is genuine.
	 *
	 * @param string $header    Raw `avex-signature` header value.
	 * @param string $body      Raw request body, exactly as received.
	 * @param string $secret    Endpoint secret, shown once at creation.
	 * @param int    $now       Current unix time; injectable so the window is testable.
	 * @param int    $tolerance Replay window in seconds.
	 * @return array{valid: bool, reason: string}
	 */
	public static function verify(
		string $header,
		string $body,
		string $secret,
		int $now = 0,
		int $tolerance = self::TOLERANCE_SECONDS
	): array {
		if ( 0 === $now ) {
			$now = time();
		}

		/**
		 * An empty secret can never verify anything.
		 *
		 * Checked explicitly because HMAC with an empty key is a perfectly valid HMAC —
		 * so a misconfigured plugin would otherwise accept any request whose sender knew
		 * that the secret was blank, which is to say any request at all.
		 */
		if ( '' === $secret ) {
			return array(
				'valid'  => false,
				'reason' => 'no webhook secret is configured',
			);
		}

		$parts = array();
		foreach ( explode( ',', $header ) as $piece ) {
			$pair = explode( '=', trim( $piece ), 2 );
			if ( 2 === count( $pair ) ) {
				$parts[ $pair[0] ] = $pair[1];
			}
		}

		if ( ! isset( $parts['t'], $parts['v1'] ) ) {
			return array(
				'valid'  => false,
				'reason' => 'malformed signature header',
			);
		}

		// `is_numeric` rather than a cast: `(int) 'abc'` is 0, which is a timestamp in
		// 1970 and would fail the window check for the wrong reason.
		if ( ! is_numeric( $parts['t'] ) ) {
			return array(
				'valid'  => false,
				'reason' => 'malformed timestamp',
			);
		}

		$timestamp = (int) $parts['t'];
		if ( abs( $now - $timestamp ) > $tolerance ) {
			return array(
				'valid'  => false,
				'reason' => 'timestamp outside the replay window',
			);
		}

		$expected = hash_hmac( 'sha256', $timestamp . '.' . $body, $secret );

		/**
		 * `hash_equals`, never `===`.
		 *
		 * String comparison in PHP returns as soon as two bytes differ, which leaks how
		 * much of a guess was right. That is enough to recover a signature one byte at a
		 * time given enough attempts, and this endpoint is public by necessity.
		 */
		if ( ! hash_equals( $expected, (string) $parts['v1'] ) ) {
			return array(
				'valid'  => false,
				'reason' => 'signature mismatch',
			);
		}

		return array(
			'valid'  => true,
			'reason' => '',
		);
	}
}

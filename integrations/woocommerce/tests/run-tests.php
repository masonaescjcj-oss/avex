<?php
/**
 * Plugin tests, runnable with plain PHP.
 *
 * No PHPUnit and no WordPress. The two classes under test were written free of both
 * precisely so this file can run anywhere `php` exists — a signature check that has never
 * been executed is a signature check that does not work, and "we could not easily test
 * it" is how that happens.
 *
 * Run: php integrations/woocommerce/tests/run-tests.php
 *
 * @package AvexPay
 */

declare( strict_types = 1 );

define( 'AVEX_PAY_TESTING', true );

require_once __DIR__ . '/../includes/class-avex-signature.php';
require_once __DIR__ . '/../includes/class-avex-outcome.php';
require_once __DIR__ . '/../includes/class-avex-client.php';

$passed = 0;
$failed = array();

/**
 * Assert and record.
 *
 * @param string $name Test name.
 * @param bool   $ok   Whether it held.
 * @param string $detail Extra context on failure.
 */
function check( string $name, bool $ok, string $detail = '' ): void {
	global $passed, $failed;
	if ( $ok ) {
		$passed++;
		echo "ok    $name\n";
		return;
	}
	$failed[] = $name . ( '' !== $detail ? " [$detail]" : '' );
	echo "FAIL  $name" . ( '' !== $detail ? "  [$detail]" : '' ) . "\n";
}

/** A correctly signed delivery, as AVEX would send it. */
function sign( string $body, string $secret, int $timestamp ): string {
	return 't=' . $timestamp . ',v1=' . hash_hmac( 'sha256', $timestamp . '.' . $body, $secret );
}

$secret = 'whsec_a_test_secret_value';
$body   = '{"event":"invoice.paid","invoice":{"id":"4d2a","status":"paid"}}';
$now    = 1786000000;

// ── signature verification ──────────────────────────────────────────────────

$result = Avex_Signature::verify( sign( $body, $secret, $now ), $body, $secret, $now );
check( 'a correctly signed delivery verifies', true === $result['valid'], $result['reason'] );

// The property the whole scheme exists for: the body cannot be changed.
$result = Avex_Signature::verify(
	sign( $body, $secret, $now ),
	str_replace( 'paid', 'overpaid', $body ),
	$secret,
	$now
);
check( 'a tampered body is refused', false === $result['valid'] );

$result = Avex_Signature::verify( sign( $body, 'the-wrong-secret', $now ), $body, $secret, $now );
check( 'the wrong secret is refused', false === $result['valid'] );

/**
 * Replay. The timestamp is inside the signature, so an attacker who captured a "paid"
 * delivery cannot re-send it later with a fresh timestamp — that invalidates the digest.
 */
$result = Avex_Signature::verify( sign( $body, $secret, $now - 3600 ), $body, $secret, $now );
check( 'an hour-old delivery is refused', false === $result['valid'] );
check( 'and the reason names the window', str_contains( $result['reason'], 'replay window' ), $result['reason'] );

// A clock a little adrift is tolerated; a clock ahead as well as behind.
$result = Avex_Signature::verify( sign( $body, $secret, $now - 120 ), $body, $secret, $now );
check( 'two minutes late is accepted', true === $result['valid'], $result['reason'] );
$result = Avex_Signature::verify( sign( $body, $secret, $now + 120 ), $body, $secret, $now );
check( 'two minutes early is accepted', true === $result['valid'], $result['reason'] );

// A forged timestamp does not help: it is covered by the digest.
$signed = sign( $body, $secret, $now - 3600 );
$forged = preg_replace( '/^t=\d+/', 't=' . $now, $signed );
$result = Avex_Signature::verify( (string) $forged, $body, $secret, $now );
check( 'rewriting the timestamp invalidates the signature', false === $result['valid'] );
check( 'and it fails as a mismatch, not as a stale timestamp', 'signature mismatch' === $result['reason'], $result['reason'] );

/**
 * An empty secret must never verify.
 *
 * HMAC with an empty key is a perfectly valid HMAC, so without an explicit check a
 * misconfigured plugin would accept any request from anyone who guessed the secret was
 * blank — which is to say any request at all.
 */
$result = Avex_Signature::verify( sign( $body, '', $now ), $body, '', $now );
check( 'an empty secret verifies nothing', false === $result['valid'] );
check( 'and says the secret is missing', str_contains( $result['reason'], 'secret' ), $result['reason'] );

foreach ( array( '', 'garbage', 't=123', 'v1=abc', 't=notanumber,v1=abc' ) as $bad ) {
	$result = Avex_Signature::verify( $bad, $body, $secret, $now );
	check( "a malformed header is refused: '$bad'", false === $result['valid'] );
}

// ── decimal to micro-dollars ────────────────────────────────────────────────

/**
 * The obvious implementation is `(int) round( $amount * 1000000 )` and it is wrong.
 *
 * Binary floating point cannot hold 19.99 exactly, so a store selling at that price would
 * invoice a cent out often enough for someone to notice. These cases are the ones that
 * catch it.
 */
foreach ( array(
	array( '19.99', '19990000' ),
	array( '0.01', '10000' ),
	array( '100', '100000000' ),
	array( '0.5', '500000' ),
	array( '1234.56', '1234560000' ),
	array( '0', '0' ),
	array( '0.00', '0' ),
	// More precision than micro-dollars can hold is truncated, never rounded up:
	// inventing precision would overcharge.
	array( '1.0000009', '1000000' ),
	// A currency-formatted total, as some WooCommerce filters produce.
	array( ' 42.50 ', '42500000' ),
) as $case ) {
	list( $input, $expected ) = $case;
	$actual = Avex_Client::to_micros( $input );
	check( "'$input' becomes $expected micro-dollars", $expected === $actual, $actual );
}

// A float round-trip would produce 19989999 or 19990000 unpredictably; the string path
// is exact every time, so the same input always gives the same body.
check(
	'the conversion is exact rather than nearly right',
	'19990000' === Avex_Client::to_micros( '19.99' ) && '2999990000' === Avex_Client::to_micros( '2999.99' )
);

// ── properties no behavioural test can see ──────────────────────────────────

/**
 * Constant-time comparison, asserted against the source.
 *
 * This is deliberate rather than lazy. `hash_equals` and `===` accept and reject exactly
 * the same inputs — the difference is only in how long they take, so no functional test
 * can tell them apart, and a mutation swapping one for the other passes everything above.
 *
 * What it changes is that `===` returns as soon as two bytes differ, which leaks how much
 * of a guess was right and lets a signature be recovered a byte at a time. This endpoint
 * is public by necessity, so the property matters more than most, and checking the source
 * is the only way to hold it.
 */
$source = (string) file_get_contents( __DIR__ . '/../includes/class-avex-signature.php' );
check( 'the signature is compared with hash_equals', str_contains( $source, 'hash_equals(' ) );
check(
	'and never with a short-circuiting comparison',
	! preg_match( '/\$parts\[.v1.\]\s*(===|!==|==|!=)/', $source ),
	'a direct comparison against the provided signature leaks timing'
);

// ── what a webhook means for an order ───────────────────────────────────────

/** Build an invoice payload. */
function invoice( array $overrides = array() ): array {
	return array_merge(
		array(
			'id'         => '4d2a',
			'mode'       => 'live',
			'chain'      => 'bsc',
			'status'     => 'paid',
			'amountDue'  => '20100502512562814071',
			'amountPaid' => '20100502512562814071',
		),
		$overrides
	);
}

$outcome = Avex_Outcome::decide( invoice(), 'live' );
check( 'a paid invoice completes the order', Avex_Outcome::ACTION_COMPLETE === $outcome['action'], $outcome['action'] );
check( 'and the note records both figures', str_contains( $outcome['note'], '20100502512562814071' ) || str_contains( $outcome['note'], (string) PHP_INT_MAX ) );

/**
 * The mismatch that would give goods away. A live order completed by a test invoice is a
 * free order, and a merchant with a test key in one place and a live key in another would
 * otherwise ship against a simulated payment.
 */
$outcome = Avex_Outcome::decide( invoice( array( 'mode' => 'test' ) ), 'live' );
check( 'a test invoice never completes a live order', Avex_Outcome::ACTION_IGNORE === $outcome['action'], $outcome['action'] );
$outcome = Avex_Outcome::decide( invoice( array( 'mode' => 'live' ) ), 'test' );
check( 'and a live invoice never completes a test order', Avex_Outcome::ACTION_IGNORE === $outcome['action'], $outcome['action'] );
$outcome = Avex_Outcome::decide( invoice( array( 'mode' => 'test' ) ), 'test' );
check( 'a test invoice completes a test order', Avex_Outcome::ACTION_COMPLETE === $outcome['action'], $outcome['action'] );

// Overpaid is covered but owes a refund, so a human should look at it.
$outcome = Avex_Outcome::decide( invoice( array( 'status' => 'overpaid', 'amountPaid' => '30000000000000000000' ) ), 'live' );
check( 'an overpayment goes on hold rather than completing', Avex_Outcome::ACTION_ON_HOLD === $outcome['action'], $outcome['action'] );
check( 'and the note asks for a refund', str_contains( $outcome['note'], 'Refund' ) );

/**
 * Underpaid has real money against it. Failing would tell the merchant nothing arrived,
 * and the customer can still make up the difference to the same address.
 */
$outcome = Avex_Outcome::decide( invoice( array( 'status' => 'underpaid', 'amountPaid' => '10000000000000000000' ) ), 'live' );
check( 'an underpayment goes on hold, not failed', Avex_Outcome::ACTION_ON_HOLD === $outcome['action'], $outcome['action'] );
check( 'and the shortfall is named', str_contains( $outcome['note'], 'short by' ) );

$outcome = Avex_Outcome::decide( invoice( array( 'status' => 'confirming', 'amountPaid' => '0' ) ), 'live' );
check( 'confirming leaves the order pending', Avex_Outcome::ACTION_PENDING === $outcome['action'], $outcome['action'] );

$outcome = Avex_Outcome::decide( invoice( array( 'status' => 'expired', 'amountPaid' => '0' ) ), 'live' );
check( 'an expired invoice with nothing received fails', Avex_Outcome::ACTION_FAILED === $outcome['action'], $outcome['action'] );

/**
 * The one an obvious implementation gets wrong. An expired invoice that received money is
 * a late payer, not an absent one — failing it would tell a merchant to forget an order
 * they have been paid for.
 */
$outcome = Avex_Outcome::decide( invoice( array( 'status' => 'expired', 'amountPaid' => '5000000000000000000' ) ), 'live' );
check( 'an expired invoice with money on it does not fail', Avex_Outcome::ACTION_ON_HOLD === $outcome['action'], $outcome['action'] );

/**
 * A status this plugin has never heard of must not fall through to complete or failed.
 * Leaving the order alone is recoverable; shipping against a misread status is not.
 */
$outcome = Avex_Outcome::decide( invoice( array( 'status' => 'partially_refunded_v2' ) ), 'live' );
check( 'an unknown status changes nothing', Avex_Outcome::ACTION_IGNORE === $outcome['action'], $outcome['action'] );
check( 'and says so plainly', str_contains( $outcome['note'], 'Unrecognised' ) );

$outcome = Avex_Outcome::decide( array(), 'live' );
check( 'an empty payload changes nothing', Avex_Outcome::ACTION_IGNORE === $outcome['action'], $outcome['action'] );

// Amounts beyond 64-bit clamp identically on both sides, so the comparison still holds.
$outcome = Avex_Outcome::decide(
	invoice( array( 'status' => 'underpaid', 'amountDue' => '9' . str_repeat( '0', 30 ), 'amountPaid' => '1' ) ),
	'live'
);
check( 'an amount beyond 64-bit does not crash the comparison', Avex_Outcome::ACTION_ON_HOLD === $outcome['action'], $outcome['action'] );

// ── summary ─────────────────────────────────────────────────────────────────

echo "\n";
if ( count( $failed ) > 0 ) {
	echo count( $failed ) . " FAILED:\n" . implode( "\n", $failed ) . "\n";
	exit( 1 );
}
echo "$passed passed\n";

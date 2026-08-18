import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  chainLabel,
  explorerUrl,
  formatUnits,
  formatUsdMicros,
  isRehearsal,
  receiptVerdict,
} from './receipt.js';

describe('verifying the payment', () => {
  test('each chain points at its own explorer', () => {
    /**
     * The most important thing on a receipt, because it is the only line that does not
     * depend on trusting us — and the reason a wrong URL is worse than none. Etherscan
     * with a BSC hash shows "not found", and the natural reading of that is that the
     * payment never happened.
     */
    const hash = `0x${'ab'.repeat(32)}`;
    assert.match(explorerUrl('bsc', hash) ?? '', /^https:\/\/bscscan\.com\/tx\/0xabab/);
    assert.match(explorerUrl('ethereum', hash) ?? '', /^https:\/\/etherscan\.io\/tx\//);
    assert.match(explorerUrl('polygon', hash) ?? '', /^https:\/\/polygonscan\.com\/tx\//);
    assert.match(explorerUrl('tron', hash) ?? '', /^https:\/\/tronscan\.org\/#\/transaction\//);
    assert.match(explorerUrl('solana', hash) ?? '', /^https:\/\/solscan\.io\/tx\//);
    assert.match(explorerUrl('ton', hash) ?? '', /^https:\/\/tonviewer\.com\/transaction\//);
  });

  test('no two chains share an explorer', () => {
    // A copy-paste in that table would send a payer to the wrong chain, which is the one
    // failure this whole function exists to avoid.
    const hash = `0x${'cd'.repeat(32)}`;
    const urls = ['bsc', 'ethereum', 'polygon', 'tron', 'solana', 'ton'].map((chain) =>
      explorerUrl(chain, hash),
    );
    assert.equal(new Set(urls).size, urls.length);
  });

  test('an unknown chain gets no link rather than a guessed one', () => {
    // The hash still renders on its own, which is verifiable by anyone who knows where to
    // look. A guessed explorer is not.
    assert.equal(explorerUrl('aptos', `0x${'ab'.repeat(32)}`), null);
  });

  test('a hash that could not be one is refused', () => {
    /**
     * The link is built from data and rendered into an anchor, so anything that is not
     * hash-shaped must not reach an href. A test invoice's own placeholder is a good
     * example of a string that is not a transaction.
     */
    assert.equal(explorerUrl('bsc', ''), null);
    assert.equal(explorerUrl('bsc', 'javascript:alert(1)'), null);
    assert.equal(explorerUrl('bsc', '0xab'), null);
    assert.equal(explorerUrl('bsc', `0x${'ab'.repeat(32)}?x=<script>`), null);
  });

  test('a chain reads as its own name, not as our identifier', () => {
    assert.equal(chainLabel('bsc'), 'BNB Chain');
    assert.equal(chainLabel('ton'), 'TON');
    // An identifier we do not know is shown as-is rather than blanked.
    assert.equal(chainLabel('aptos'), 'aptos');
  });
});

describe('what the receipt says at the top', () => {
  const base = { amountDue: '20000000', amountPaid: '20000000', decimals: 6, symbol: 'USDT' };

  test('a settled payment reads as settled, with nothing outstanding', () => {
    const verdict = receiptVerdict({ ...base, status: 'paid' });
    assert.equal(verdict.headline, 'Paid in full');
    assert.equal(verdict.tone, 'good');
    assert.equal(verdict.note, null);
  });

  test('an overpayment gets a receipt that names the difference', () => {
    /**
     * The money arrived, so the payer is entitled to the record — but it must not print as
     * a clean settlement. Somebody is owed a refund, and a receipt that hid that would be
     * the document the payer was later told to disregard.
     */
    const verdict = receiptVerdict({ ...base, status: 'overpaid', amountPaid: '25500000' });
    assert.equal(verdict.tone, 'warn');
    assert.match(verdict.headline, /more than the amount due/);
    assert.match(verdict.note ?? '', /5\.5 USDT more/);
    assert.match(verdict.note ?? '', /owes you the difference/);
  });

  test('an overpayment with no measurable excess still says a refund is owed', () => {
    // Reached if the amounts are equal but the status says otherwise. The status is what
    // the watcher decided, so it wins — and dropping the note would lose the refund.
    const verdict = receiptVerdict({ ...base, status: 'overpaid' });
    assert.equal(verdict.tone, 'warn');
    assert.match(verdict.note ?? '', /owes you the difference/);
  });

  test('a test payment is a rehearsal, whatever it is called', () => {
    /**
     * The addresses on a test invoice are valid on no chain, so nothing was ever sent. A
     * document headed "Paid in full" with a real-looking amount is exactly the thing
     * somebody files and later produces as proof of a payment that never existed.
     */
    assert.equal(isRehearsal('test'), true);
    assert.equal(isRehearsal('live'), false);
    // Anything unrecognised is treated as a rehearsal: the safe direction to be wrong in
    // is refusing to call something real.
    assert.equal(isRehearsal(''), true);
  });
});

describe('the figures on the page', () => {
  test('an amount keeps every unit and loses its trailing zeros', () => {
    assert.equal(formatUnits('20100502512562814071', 18), '20.100502512562814071');
    assert.equal(formatUnits('20000000', 6), '20');
    assert.equal(formatUnits('1', 18), '0.000000000000000001');
  });

  test('an amount beyond double precision is exact', () => {
    // 18-decimal amounts are routinely above 2^53, which is why none of this is a float.
    assert.equal(formatUnits('9007199254740993000000000', 18), '9,007,199.254740993');
  });

  test('the whole part is grouped and the fraction is not', () => {
    // Grouping a fraction is not a convention anybody reads.
    assert.equal(formatUnits('1234567891234', 6), '1,234,567.891234');
    assert.ok(!formatUnits('1000000000000000001', 18).includes(',0'));
  });

  test('a zero-decimal asset formats as a plain integer', () => {
    assert.equal(formatUnits('64000', 0), '64,000');
  });

  test('dollars keep two places and group', () => {
    assert.equal(formatUsdMicros('20000000'), '$20.00');
    assert.equal(formatUsdMicros('1234567890000'), '$1,234,567.89');
  });

  test('a malformed figure reads as zero rather than NaN', () => {
    // A bug upstream must not put "NaN" on a document somebody files.
    assert.equal(formatUnits('not-a-number', 6), '0');
    assert.equal(formatUsdMicros(''), '$0.00');
  });
});

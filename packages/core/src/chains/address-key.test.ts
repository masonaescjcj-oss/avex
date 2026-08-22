import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SUPPORTED_CHAINS, chainConfig } from './registry.js';
import { addressKey, foldsAddressCase } from './address-key.js';

/**
 * Which chains may have an address's case folded away, held to the reason rather than a list.
 *
 * The integration test in `apps/api` proves the behaviour end to end, but only on the two
 * chains it seeds. This one guards the registry entries the others depend on: marking a hex
 * chain `sensitive` stops every payment on it being recognised, and marking a base58 chain
 * `insensitive` credits payments to the wrong invoice. Both are one word in a config object.
 */
describe('address comparison keys', () => {
  test('hex chains fold and base58 chains do not', () => {
    const folding = SUPPORTED_CHAINS.filter((chain) => foldsAddressCase(chain));
    assert.deepEqual([...folding].sort(), ['bsc', 'ethereum', 'polygon']);

    // Said as the property rather than the list, so a new chain is caught by whichever of the
    // two assertions it contradicts.
    for (const chain of SUPPORTED_CHAINS) {
      const isEvmHex = ['ethereum', 'polygon', 'bsc'].includes(chain);
      assert.equal(
        chainConfig(chain).addressCase,
        isEvmHex ? 'insensitive' : 'sensitive',
        `${chain} has the wrong addressCase`,
      );
    }
  });

  test('an EVM key is lowercase, whatever case it arrives in', () => {
    const mixed = '0xAbC0000000000000000000000000000000000001';
    assert.equal(addressKey('bsc', mixed), mixed.toLowerCase());
    assert.equal(addressKey('bsc', mixed.toLowerCase()), mixed.toLowerCase());
    assert.equal(addressKey('ethereum', ` ${mixed} `), mixed.toLowerCase());
  });

  test('a TRON key is the canonical base58 form, from any of its forms', () => {
    const base58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const hex21 = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';

    assert.equal(addressKey('tron', base58), base58);
    assert.equal(addressKey('tron', hex21), base58);
    assert.equal(addressKey('tron', `0x${hex21.slice(2)}`), base58);
    // And a folded one is emphatically not the same key.
    assert.notEqual(addressKey('tron', base58.toLowerCase()), base58);
  });

  test('an unparseable address is returned as given, not thrown on', () => {
    /**
     * The watcher calls this with whatever a chain reported. "No invoice owns this" is the
     * answer; an exception would take the poll loop down over a stranger's transfer.
     */
    assert.equal(addressKey('tron', 'nonsense'), 'nonsense');
    assert.equal(addressKey('solana', ' SoMeThing '), 'SoMeThing');
  });
});

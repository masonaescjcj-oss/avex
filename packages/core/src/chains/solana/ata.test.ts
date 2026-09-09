import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { base58Decode } from '../base58.js';
import { solanaAddressBytes } from './address.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAccount,
  findProgramAddress,
  isOnCurve,
} from './ata.js';

/**
 * The derivation, against real mainnet accounts.
 *
 * This is the file that has to be right or Solana silently takes no payments: the address
 * derived here is the only one the watcher asks the chain about, and a wrong one is an
 * address a payer's money never reaches. There is no error and no log line — it looks exactly
 * like nobody having paid.
 *
 * So the vectors are not invented. Each pair below was read off a confirmed USDT or USDC
 * transfer on Solana mainnet: the `owner` is the wallet whose balance went up and the
 * `account` is the token account the transfer credited. If the arithmetic in `ata.ts` drifts,
 * these stop matching.
 */

const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const VECTORS = [
  {
    /**
     * The interesting one: bump 255 hashes to a point *on* the curve, so the runtime skipped
     * it and this account is bump 254. An `isOnCurve` that always said false would derive a
     * different address here and the same address for the others — which is why one vector
     * would not have been enough.
     */
    owner: '5ae14fSaLi4cpLpCqVDHgAYXk7CLNPQ84a6yZj5WkHXv',
    mint: USDT,
    account: 'Gn3KwprR13aYHNLqyqVaZzRkTUSDBnHeQ7xmgntGAXtt',
  },
  {
    owner: 'GdwMqCXuP6dUMAvGFfHz1dU8nfMHofr2ji5QjKoaDNUj',
    mint: USDT,
    account: '2zL11wu5vf5TZ1c7XKmKukpusDvaLcPEMZvzwV7yYDcm',
  },
  {
    owner: 'CFJr1M2z3SZpQpBMoY3nagpafvS7Uzanq4L7KVXVKi22',
    mint: USDC,
    account: 'EwMT4XojLWZHUTNUrVqNGXcbW3i4sD7AbdX3j8eP4hsk',
  },
  {
    owner: 'ELdyuNAKJpabeFKrePFU2eNnpdTKZBMgj8BcragTFjHs',
    mint: USDC,
    account: '9MQVJhznbTzvBEUWwFmGxKWugp3mJkWi8DWakdwj8nRg',
  },
  {
    owner: 'R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX',
    mint: USDC,
    account: 'HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq',
  },
] as const;

describe('the associated token account', () => {
  test('is derived exactly as mainnet has it', () => {
    for (const vector of VECTORS) {
      assert.equal(
        associatedTokenAccount(vector.owner, vector.mint),
        vector.account,
        `${vector.owner} holding ${vector.mint === USDT ? 'USDT' : 'USDC'}`,
      );
    }
  });

  test('is a different address for Token-2022, so the mint’s program matters', () => {
    /**
     * The program is part of the seeds. Deriving with the wrong one gives a real-looking
     * address that can never receive anything, which is why the adapter reads the mint's
     * owning program rather than assuming the classic one.
     */
    const { owner, mint, account } = VECTORS[0];
    assert.equal(associatedTokenAccount(owner, mint, TOKEN_PROGRAM_ID), account);
    assert.notEqual(associatedTokenAccount(owner, mint, TOKEN_2022_PROGRAM_ID), account);
  });

  test('is deterministic', () => {
    const { owner, mint } = VECTORS[1];
    assert.equal(associatedTokenAccount(owner, mint), associatedTokenAccount(owner, mint));
  });
});

describe('what may be signed for', () => {
  test('an ordinary wallet is a curve point, because it is somebody’s public key', () => {
    for (const owner of VECTORS.slice(0, 4).map((vector) => vector.owner)) {
      assert.equal(isOnCurve(solanaAddressBytes(owner)), true, owner);
    }
  });

  test('an owner may itself be a program address, and derives the same way', () => {
    /**
     * The last vector's owner is a PDA — a program's vault, not a wallet anybody holds a key
     * to — and it owns a USDC token account like any other. Found while checking these
     * against mainnet, and worth an assertion: nothing in the derivation may assume the
     * merchant's address is a keypair account, and nothing here does.
     */
    const vault = VECTORS[4];
    assert.equal(isOnCurve(solanaAddressBytes(vault.owner)), false, 'not a public key');
    assert.equal(associatedTokenAccount(vault.owner, vault.mint), vault.account);
  });

  test('a derived token account is not, which is the point of deriving it', () => {
    /**
     * A program address that were a valid public key would be an account somebody could hold
     * the key to while the token program believed only it could move the balance. The whole
     * bump loop exists to guarantee this, so it is asserted rather than assumed.
     */
    for (const vector of VECTORS) {
      assert.equal(isOnCurve(base58Decode(vector.account)), false, vector.account);
    }
  });

  test('the mints themselves are curve points', () => {
    // They are ordinary accounts created from keypairs, unlike the accounts derived from them.
    assert.equal(isOnCurve(solanaAddressBytes(USDT)), true);
    assert.equal(isOnCurve(solanaAddressBytes(USDC)), true);
  });

  test('anything but 32 bytes is not a point', () => {
    assert.equal(isOnCurve(new Uint8Array(31)), false);
    assert.equal(isOnCurve(new Uint8Array(33)), false);
  });
});

describe('findProgramAddress', () => {
  test('agrees with the associated-account helper it backs', () => {
    const { owner, mint, account } = VECTORS[2];
    assert.equal(
      findProgramAddress(
        [solanaAddressBytes(owner), base58Decode(TOKEN_PROGRAM_ID), base58Decode(mint)],
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      ),
      account,
    );
  });

  test('a different seed order is a different address', () => {
    // Seeds are ordered, and swapping two produces a valid address that receives nothing.
    const { owner, mint, account } = VECTORS[2];
    assert.notEqual(
      findProgramAddress(
        [base58Decode(mint), base58Decode(TOKEN_PROGRAM_ID), solanaAddressBytes(owner)],
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      ),
      account,
    );
  });
});

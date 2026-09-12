import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SecretBox, SecretBoxError } from './secret-box.js';

/**
 * The one value in this database stored so it can be read back.
 *
 * Everything else that is secret is hashed, because nothing needs the original. A merchant's
 * bot token has to be presented to Telegram on every call, so it survives the round trip — and
 * a value that can be read back is a value worth being careful with.
 */

const KEY = 'a-test-encryption-key-long-enough';
const TOKEN = '8123456789:AAH-thisIsNotARealBotTokenButItIsTheRightShape';

describe('SecretBox', () => {
  test('what goes in comes back out', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal(TOKEN, 'bot:abc');
    assert.equal(box.open(sealed, 'bot:abc'), TOKEN);
  });

  test('the ciphertext does not contain the secret', () => {
    // Stated because it is the whole claim being made to the merchant.
    const sealed = new SecretBox(KEY).seal(TOKEN, 'bot:abc');
    assert.equal(sealed.includes(TOKEN), false);
    assert.equal(sealed.includes('AAH-this'), false);
  });

  test('sealing twice gives two different ciphertexts', () => {
    /**
     * A fresh nonce each time. Without it, two merchants who happened to paste the same token
     * would produce identical rows — which tells anyone reading the table that they match,
     * without decrypting anything.
     */
    const box = new SecretBox(KEY);
    assert.notEqual(box.seal(TOKEN, 'bot:abc'), box.seal(TOKEN, 'bot:abc'));
  });

  test('a ciphertext moved to another row does not open', () => {
    /**
     * The attack the label exists to stop: lift one organisation's sealed token, paste it into
     * another's row, and take payments through somebody else's bot. Without binding, that
     * decrypts perfectly.
     */
    const box = new SecretBox(KEY);
    const sealed = box.seal(TOKEN, 'bot:mine');
    assert.throws(() => box.open(sealed, 'bot:theirs'), SecretBoxError);
  });

  test('a different key does not open it', () => {
    const sealed = new SecretBox(KEY).seal(TOKEN, 'bot:abc');
    assert.throws(() => new SecretBox('a-completely-different-key-here').open(sealed, 'bot:abc'), SecretBoxError);
  });

  test('an edited ciphertext is refused rather than opened as something else', () => {
    // What GCM buys over plain AES: a tampered value fails, instead of decrypting to garbage
    // that some caller then treats as a token.
    const box = new SecretBox(KEY);
    const sealed = box.seal(TOKEN, 'bot:abc');
    const parts = sealed.split('.');
    const body = Buffer.from(parts[3]!, 'base64url');
    body[0] = body[0]! ^ 0x01;
    parts[3] = body.toString('base64url');
    assert.throws(() => box.open(parts.join('.'), 'bot:abc'), SecretBoxError);
  });

  test('a value from a scheme this build does not know is refused', () => {
    // Rather than decrypted into nonsense, which is what a rotation would otherwise produce.
    const box = new SecretBox(KEY);
    const sealed = box.seal(TOKEN, 'bot:abc');
    const future = sealed.replace(/^v1\./, 'v2.');
    assert.throws(() => box.open(future, 'bot:abc'), /does not|understand/i);
    assert.throws(() => box.open('not-sealed-at-all', 'bot:abc'), SecretBoxError);
  });

  test('every failure says the same thing', () => {
    /**
     * Wrong key, edited ciphertext and a lifted value are three causes with one honest
     * answer. Telling them apart would tell whoever is probing which one they achieved.
     */
    const box = new SecretBox(KEY);
    const sealed = box.seal(TOKEN, 'bot:mine');
    const wrongLabel = message(() => box.open(sealed, 'bot:theirs'));
    const wrongKey = message(() => new SecretBox('another-key-entirely-here').open(sealed, 'bot:mine'));
    assert.equal(wrongLabel, wrongKey);
  });

  test('a key too short to be a key is refused at construction', () => {
    // Where it can still be fixed, rather than at the first token a merchant pastes.
    assert.throws(() => new SecretBox('short'), /at least 16/);
  });

  test('two sealed values can be compared without opening either to a caller', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal(TOKEN, 'bot:abc');
    assert.equal(box.holdsSame(sealed, 'bot:abc', TOKEN), true);
    assert.equal(box.holdsSame(sealed, 'bot:abc', `${TOKEN}x`), false);
    assert.equal(box.holdsSame(sealed, 'bot:other', TOKEN), false, 'the label still binds');
  });
});

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a failure');
}

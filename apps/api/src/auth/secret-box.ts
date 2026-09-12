import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Encrypting a secret we have to be able to read back.
 *
 * Everything else in this codebase that stores a credential stores a *hash* of it — a password,
 * an API key, a session token — because nothing ever needs the original back. A merchant's
 * Telegram bot token is the first thing that is not like that: we have to present it to
 * Telegram on every call, so it must survive a round trip.
 *
 * That makes it the one value in the database worth encrypting rather than hashing, and the
 * distinction matters more than it looks. A hash column leaks nothing when the database does.
 * This one leaks everything unless the key lives somewhere the database is not — which is why
 * the key comes from the environment file, mode 0600 on the host, and never from a column.
 *
 * ## The shape
 *
 * AES-256-GCM, which authenticates as well as encrypts: a ciphertext somebody edited fails to
 * open rather than opening as something else. The stored string is
 *
 *     v1.<iv, base64url>.<tag, base64url>.<ciphertext, base64url>
 *
 * The version prefix is there so a future key rotation has somewhere to say what it did. It is
 * checked rather than skipped, because a value written by a scheme we no longer understand must
 * be refused loudly and not decrypted into nonsense.
 *
 * ## Associated data
 *
 * Every call binds the ciphertext to a label — in practice the row's own id. Without it a
 * ciphertext lifted from one row and pasted into another would decrypt perfectly, which is how
 * one merchant ends up taking payments through another merchant's bot. With it, the same paste
 * fails the tag check.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export class SecretBox {
  private readonly key: Buffer;

  /**
   * The key is derived from the configured string rather than used raw.
   *
   * An operator sets `TOKEN_ENCRYPTION_KEY` by hand or by `openssl rand`, so its length and
   * alphabet are whatever they typed; AES needs exactly 32 bytes. Hashing gets there from any
   * input without silently truncating a long key to its first 32 characters — which would make
   * two different keys the same key, and nobody would ever find out.
   */
  constructor(secret: string) {
    if (secret.length < 16) {
      throw new SecretBoxError('the encryption key must be at least 16 characters');
    }
    this.key = createHash('sha256').update(`avex.secret-box.${VERSION}:${secret}`).digest();
  }

  seal(plaintext: string, label: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(label, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, b64(iv), b64(tag), b64(body)].join('.');
  }

  open(sealed: string, label: string): string {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new SecretBoxError('not a sealed value this build understands');
    }

    const iv = unb64(parts[1]!);
    const tag = unb64(parts[2]!);
    const body = unb64(parts[3]!);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretBoxError('sealed value is malformed');
    }

    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(label, 'utf8'));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      /**
       * One message for every way this fails, on purpose.
       *
       * Wrong key, edited ciphertext, and a value lifted from another row are three different
       * causes with one honest answer: this value cannot be trusted. Distinguishing them in
       * the message would tell whoever is probing which of the three they achieved.
       */
      throw new SecretBoxError('sealed value could not be opened: wrong key, or it was altered');
    }
  }

  /** Whether two sealed values hold the same secret, without either being returned. */
  holdsSame(sealed: string, label: string, candidate: string): boolean {
    let plaintext: string;
    try {
      plaintext = this.open(sealed, label);
    } catch {
      return false;
    }
    const a = Buffer.from(plaintext, 'utf8');
    const b = Buffer.from(candidate, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

const b64 = (value: Buffer): string => value.toString('base64url');
const unb64 = (value: string): Buffer => Buffer.from(value, 'base64url');

import { randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

/**
 * An SMTP submission client, written here rather than taken from a provider's SDK.
 *
 * ## Why SMTP and not an HTTP email API
 *
 * Resend, Postmark, SendGrid and SES all have simpler interfaces than this file, and all of
 * them decide who may use them. This gateway is operated from Iran, where those decisions
 * routinely go the other way — and an outage caused by a vendor's compliance review would take
 * out email verification, which is the front door of the product.
 *
 * SMTP is the one transport that works with any provider, including a regional one or a mail
 * server the operator runs themselves. Changing provider becomes a change of URL rather than a
 * change of code, and nothing here has a dependency to audit.
 *
 * ## What is deliberately strict
 *
 * Credentials are never sent over a plaintext connection. `smtp://` takes STARTTLS whenever it
 * is offered, and refuses to continue at all when there is a password and the server cannot
 * encrypt — a mail password sends mail as us, and "the server did not support encryption" is not
 * a reason to hand it over. A relay with no credentials is allowed in plaintext, because that is
 * what a mail server on the same host looks like.
 *
 * And a recipient address or subject containing a newline is rejected, not escaped. Header
 * injection through an email address is the classic way a signup form becomes an open relay:
 * an address with a line break and a `Bcc:` after it is a valid-looking string that would
 * otherwise become two headers.
 */

export class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpError';
  }
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** True for implicit TLS (465). False means plaintext, then STARTTLS (587). */
  readonly implicitTls: boolean;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  /**
   * Whether to accept a certificate that does not verify.
   *
   * Exists for a self-hosted server with an internal certificate authority, and defaults to
   * off. A gateway that silently accepted any certificate would be handing its mail password
   * to whoever answered the connection.
   */
  readonly insecureTls?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface Envelope {
  /** Bare address, used in `MAIL FROM`. */
  readonly from: string;
  /** Display name for the `From:` header. Optional. */
  readonly fromName?: string | undefined;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * `smtps://user:pass@host:465` or `smtp://user:pass@host:587`.
 *
 * Percent-decoded, because a mail password containing an `@` or a `/` is ordinary and a URL
 * that was not decoded would authenticate with the wrong string — then report it as a rejected
 * login, which sends whoever is deploying to look at the wrong thing.
 */
export function parseSmtpUrl(url: string): SmtpConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SmtpError(`SMTP_URL is not a URL: ${url}`);
  }

  const implicitTls = parsed.protocol === 'smtps:';
  if (!implicitTls && parsed.protocol !== 'smtp:') {
    throw new SmtpError(`SMTP_URL must be smtp:// or smtps://, got ${parsed.protocol}`);
  }
  if (!parsed.hostname) throw new SmtpError('SMTP_URL has no host');

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : implicitTls ? 465 : 587,
    implicitTls,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    /**
     * `?insecure=true`, and it has to be asked for in the URL.
     *
     * A flag in the connection string is visible to whoever is deploying and travels with the
     * server it applies to, where a separate environment variable would be set once and then
     * forgotten across a change of provider.
     */
    ...(parsed.searchParams.get('insecure') === 'true' ? { insecureTls: true } : {}),
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** One message, one connection. */
export async function sendMail(config: SmtpConfig, envelope: Envelope): Promise<void> {
  assertHeaderSafe(envelope.to, 'recipient');
  assertHeaderSafe(envelope.subject, 'subject');
  assertHeaderSafe(envelope.from, 'sender');

  const session = await open(config);
  try {
    await session.expect(220);

    let capabilities = await session.command('EHLO avex-pay', 250);

    if (!config.implicitTls) {
      const offered = /STARTTLS/i.test(capabilities);
      /**
       * Upgraded whenever it is offered, and required whenever there is a password.
       *
       * Two rules rather than one, because the two situations are different. A credential that
       * sends mail as us must never cross a network in the clear, so a server that cannot
       * encrypt is refused rather than accommodated. An unauthenticated relay — a mail server on
       * the same host, or one that accepts by IP — has no credential to protect, and refusing it
       * would rule out the setup an operator running their own mail is most likely to have.
       *
       * Encryption is still taken when it is available in that case, because it costs one round
       * trip and the message itself is worth hiding.
       */
      if (!offered && config.password !== undefined) {
        throw new SmtpError(
          `${config.host} does not offer STARTTLS; refusing to send credentials in plaintext`,
        );
      }
      if (offered) {
        await session.command('STARTTLS', 220);
        await session.upgrade(config);
        // Re-issued, because the capabilities before and after the upgrade are different sets
        // and AUTH is normally advertised only on the encrypted one.
        capabilities = await session.command('EHLO avex-pay', 250);
      }
    }

    if (config.username !== undefined && config.password !== undefined) {
      await authenticate(session, capabilities, config.username, config.password);
    }

    await session.command(`MAIL FROM:<${envelope.from}>`, 250);
    await session.command(`RCPT TO:<${envelope.to}>`, 250);
    await session.command('DATA', 354);
    await session.command(`${message(envelope)}\r\n.`, 250);
    await session.command('QUIT', 221).catch(() => {
      /**
       * A server that drops the connection rather than answering QUIT has still accepted the
       * message — the 250 above is the acknowledgement. Failing here would resend it, and a
       * duplicate verification mail is a worse outcome than an unanswered goodbye.
       */
    });
  } finally {
    session.close();
  }
}

/** The separator AUTH PLAIN uses between its three fields. */
const NUL = '\u0000';

async function authenticate(
  session: Session,
  capabilities: string,
  username: string,
  password: string,
): Promise<void> {
  if (/AUTH[ =-][^\r\n]*PLAIN/i.test(capabilities)) {
    const token = Buffer.from(`${NUL}${username}${NUL}${password}`, 'utf8').toString('base64');
    await session.command(`AUTH PLAIN ${token}`, 235);
    return;
  }
  if (/AUTH[ =-][^\r\n]*LOGIN/i.test(capabilities)) {
    await session.command('AUTH LOGIN', 334);
    await session.command(Buffer.from(username, 'utf8').toString('base64'), 334);
    await session.command(Buffer.from(password, 'utf8').toString('base64'), 235);
    return;
  }
  throw new SmtpError(
    `${session.host} offers no AUTH mechanism this client implements (PLAIN or LOGIN)`,
  );
}

/**
 * The message itself: headers, then the body as base64.
 *
 * Base64 rather than the text as written, and it is not about size. A merchant's name, an
 * organisation's name and a payer's reference all reach these bodies, and any of them can be
 * in Persian — so the body is not ASCII and must not be sent as though it were. Encoding it
 * also settles every question about a line beginning with a dot, which in SMTP needs stuffing
 * and, unstuffed, truncates the message at that line.
 */
function message(envelope: Envelope): string {
  const from =
    envelope.fromName === undefined
      ? `<${envelope.from}>`
      : `${encodeHeader(envelope.fromName)} <${envelope.from}>`;

  const headers = [
    `From: ${from}`,
    `To: <${envelope.to}>`,
    `Subject: ${encodeHeader(envelope.subject)}`,
    `Date: ${rfc5322Date(new Date())}`,
    `Message-ID: <${randomUUID()}@${envelope.from.split('@')[1] ?? 'avexpay.net'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    /**
     * These are notifications, not correspondence.
     *
     * Without it, an out-of-office reply or a mailing-list loop answers the address they are
     * sent from, and one verification mail becomes two messages and a support question.
     */
    'Auto-Submitted: auto-generated',
  ];

  const encoded = Buffer.from(envelope.body, 'utf8').toString('base64');
  const wrapped = encoded.match(/.{1,76}/g) ?? [];
  return `${headers.join('\r\n')}\r\n\r\n${wrapped.join('\r\n')}`;
}

/** RFC 2047, only when it is needed — an ASCII subject stays readable in a mail log. */
function encodeHeader(value: string): string {
  if (/^[ -~]*$/.test(value)) return value;
  return `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * `Fri, 22 Aug 2026 08:00:00 +0000`.
 *
 * Written out rather than `toUTCString()`, which ends in `GMT` — obsolete syntax that some
 * spam filters score against, and free to avoid.
 */
function rfc5322Date(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${DAYS[now.getUTCDay()]}, ${pad(now.getUTCDate())} ${MONTHS[now.getUTCMonth()]} ` +
    `${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:` +
    `${pad(now.getUTCSeconds())} +0000`
  );
}

function assertHeaderSafe(value: string, what: string): void {
  if (/[\r\n]/.test(value)) {
    throw new SmtpError(`refusing to send: the ${what} contains a line break`);
  }
}

/** The socket, and the line-oriented protocol on top of it. */
interface Session {
  readonly host: string;
  expect(code: number): Promise<string>;
  command(line: string, code: number): Promise<string>;
  upgrade(config: SmtpConfig): Promise<void>;
  close(): void;
}

async function open(config: SmtpConfig): Promise<Session> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let socket: Socket | TLSSocket = config.implicitTls
    ? tlsConnect({
        host: config.host,
        port: config.port,
        servername: config.host,
        rejectUnauthorized: config.insecureTls !== true,
      })
    : netConnect({ host: config.host, port: config.port });

  let buffer = '';
  let failure: Error | undefined;
  const waiters: (() => void)[] = [];

  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };

  const attach = (target: Socket | TLSSocket) => {
    target.setEncoding('utf8');
    target.setTimeout(timeoutMs);
    target.on('data', (chunk: string) => {
      buffer += chunk;
      wake();
    });
    target.on('error', (error: Error) => {
      failure ??= error;
      wake();
    });
    target.on('timeout', () => {
      failure ??= new SmtpError(`${config.host}: timed out after ${timeoutMs}ms`);
      target.destroy();
      wake();
    });
    target.on('close', () => {
      failure ??= new SmtpError(`${config.host}: connection closed`);
      wake();
    });
  };
  attach(socket);

  /**
   * One reply, which may be several lines.
   *
   * A multi-line reply repeats the code with a hyphen — `250-STARTTLS` — and ends with a space:
   * `250 HELP`. Treating the first line as the whole reply is the bug that makes STARTTLS
   * detection fail on exactly the servers that advertise the most extensions.
   */
  const readReply = async (): Promise<string> => {
    for (;;) {
      const match = /^(?:\d{3}-[^\n]*\n)*\d{3} [^\n]*\r?\n/.exec(buffer);
      if (match) {
        const reply = buffer.slice(0, match[0].length);
        buffer = buffer.slice(match[0].length);
        return reply;
      }
      if (failure) throw failure;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };

  const session: Session = {
    host: config.host,
    async expect(code) {
      const reply = await readReply();
      /**
       * The code of the last line, which is the one carrying the verdict.
       *
       * A multi-line reply repeats the code on every line, so any of them would do — reading
       * the last is what keeps this correct if a server ever answers a greeting and a
       * capability list in one write.
       */
      const lines = reply.trimEnd().split(/\r?\n/);
      const actual = Number(lines[lines.length - 1]?.slice(0, 3));
      if (actual !== code) {
        throw new SmtpError(`${config.host}: expected ${code}, got ${reply.trim()}`);
      }
      return reply;
    },
    async command(line, code) {
      if (failure) throw failure;
      socket.write(`${line}\r\n`);
      return session.expect(code);
    },
    async upgrade(cfg) {
      const plain = socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('error');
      plain.removeAllListeners('timeout');
      plain.removeAllListeners('close');

      const secure = tlsConnect({
        socket: plain,
        servername: cfg.host,
        rejectUnauthorized: cfg.insecureTls !== true,
      });
      await new Promise<void>((resolve, reject) => {
        secure.once('secureConnect', () => resolve());
        secure.once('error', reject);
      });

      socket = secure;
      // Anything the server sent before the handshake belongs to the plaintext session and must
      // not be read as though it had come from the encrypted one.
      buffer = '';
      failure = undefined;
      attach(secure);
    },
    close() {
      socket.destroy();
    },
  };

  return session;
}

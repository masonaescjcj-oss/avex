import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { after, describe, test } from 'node:test';

import { parseSmtpUrl, sendMail, SmtpError } from './smtp.js';

/**
 * The SMTP client, against a server that answers.
 *
 * A hand-written protocol client is exactly the kind of code that appears to work: it either
 * speaks the protocol or the mail silently does not arrive, and the difference is invisible
 * from inside the process. So this stands up a real TCP server, records every line the client
 * sends, and asserts the conversation — which is also the only way to test the parts that
 * matter most and would otherwise never run: the multi-line reply parser, the refusal to
 * authenticate in plaintext, and the header-injection guard.
 *
 * Plaintext throughout, and deliberately: the client refuses to authenticate over an
 * unencrypted connection, so the tests that need credentials are the tests that need TLS, and
 * a self-signed certificate in a unit test would be testing Node's TLS stack rather than this
 * file. What is asserted here instead is that the refusal happens.
 */

interface Fake {
  readonly port: number;
  readonly transcript: string[];
  close(): Promise<void>;
}

/**
 * A server that plays a fixed script.
 *
 * `script` maps a command prefix to the reply. Anything unmatched gets a 250, so a test only
 * has to say what it cares about.
 */
async function fakeServer(options: {
  readonly greeting?: string;
  readonly script?: Readonly<Record<string, string>>;
}): Promise<Fake> {
  const transcript: string[] = [];
  let inData = false;

  const server: Server = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    socket.write(options.greeting ?? '220 fake ESMTP\r\n');

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        transcript.push(line);

        if (inData) {
          // The message body, until the lone dot that ends it.
          if (line === '.') {
            inData = false;
            socket.write('250 queued\r\n');
          }
          continue;
        }

        /**
         * The script first, then the protocol's own defaults.
         *
         * `DATA` and `QUIT` have their own codes — 354 to invite the message, 221 to say
         * goodbye — and a fake that answered 250 to everything would be a fake the real client
         * rightly rejects. Which it did, the first time this ran.
         */
        const key = Object.keys(options.script ?? {}).find((prefix) => line.startsWith(prefix));
        const reply =
          key !== undefined
            ? options.script![key]!
            : line.startsWith('DATA')
              ? '354 go ahead\r\n'
              : line.startsWith('QUIT')
                ? '221 bye\r\n'
                : '250 ok\r\n';
        socket.write(reply);
        if (line.startsWith('DATA')) inData = true;
        if (line.startsWith('QUIT')) socket.end();
      }
    });
    socket.on('error', () => {
      // A client that destroys the socket mid-conversation is a case under test, not a fault.
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    transcript,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const servers: Fake[] = [];
const start = async (options: Parameters<typeof fakeServer>[0]) => {
  const fake = await fakeServer(options);
  servers.push(fake);
  return fake;
};

after(async () => {
  for (const server of servers) await server.close();
});

/**
 * The body, decoded from the transcript.
 *
 * Everything after the blank line that separates the headers, minus the lone dot that ends the
 * message — which is protocol, not content. Including it decodes as three extra bytes of
 * nonsense on the end of the body, which is how this helper came to exist.
 */
function decodeBody(transcript: readonly string[]): string {
  const start = transcript.indexOf('') + 1;
  const lines = transcript.slice(start, transcript.indexOf('.', start));
  return Buffer.from(lines.join(''), 'base64').toString('utf8');
}

const envelope = {
  from: 'no-reply@avexpay.net',
  fromName: 'AVEX Pay',
  to: 'merchant@example.test',
  subject: 'Confirm your email address',
  body: 'Confirm your email to finish setting up AVEX Pay:\nhttps://avexpay.net/dashboard?verify=abc',
};

describe('speaking SMTP', () => {
  test('a message goes out as a complete conversation', async () => {
    const fake = await start({ script: { EHLO: '250-fake\r\n250 SIZE 10240000\r\n' } });

    await sendMail(
      { host: '127.0.0.1', port: fake.port, implicitTls: false, timeoutMs: 3_000 },
      envelope,
    );

    const commands = fake.transcript.filter((line) => /^[A-Z]{4}/.test(line));
    assert.deepEqual(
      commands.slice(0, 4),
      ['EHLO avex-pay', 'MAIL FROM:<no-reply@avexpay.net>', 'RCPT TO:<merchant@example.test>', 'DATA'],
      'the envelope must be the one the caller gave',
    );

    // The headers a mail server and a spam filter both look for.
    const data = fake.transcript.join('\n');
    assert.match(data, /^From: AVEX Pay <no-reply@avexpay\.net>$/m);
    assert.match(data, /^To: <merchant@example\.test>$/m);
    assert.match(data, /^Subject: Confirm your email address$/m);
    assert.match(data, /^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m);
    assert.match(data, /^Content-Transfer-Encoding: base64$/m);
    assert.match(data, /^Auto-Submitted: auto-generated$/m);

    // And the body survives the round trip, which base64 is there to guarantee.
    assert.equal(decodeBody(fake.transcript), envelope.body);
  });

  test('a Persian body and subject survive as themselves', async () => {
    /**
     * The reason the body is base64 and the subject is RFC 2047. A merchant's name reaches these
     * messages, and this product's merchants are Iranian — a transport that assumed ASCII would
     * deliver mojibake to every one of them.
     */
    const fake = await start({ script: { EHLO: '250 fake\r\n' } });
    const subject = 'تغییر آدرس برداشت';
    const body = 'سلام. آدرس برداشت شما تغییر کرد.';

    await sendMail({ host: '127.0.0.1', port: fake.port, implicitTls: false, timeoutMs: 3_000 }, {
      ...envelope,
      subject,
      body,
    });

    const data = fake.transcript.join('\n');
    const header = /^Subject: (.+)$/m.exec(data)?.[1] ?? '';
    assert.match(header, /^=\?utf-8\?B\?/, 'a non-ASCII subject must be encoded, not sent raw');
    assert.equal(
      Buffer.from(header.replace(/^=\?utf-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8'),
      subject,
    );

    assert.equal(decodeBody(fake.transcript), body);
  });

  test('a multi-line greeting is one reply, not several', async () => {
    /**
     * The parser bug this exists to prevent. A capability list repeats the code with a hyphen
     * and ends with a space, so a client that treated the first line as the whole reply would
     * read `250-STARTTLS` as the verdict, miss the rest, and then match the following reply
     * against the wrong command. It also would not find STARTTLS, which is the case below.
     */
    const fake = await start({
      script: { EHLO: '250-fake greets you\r\n250-PIPELINING\r\n250-8BITMIME\r\n250 SIZE 0\r\n' },
    });

    await sendMail(
      { host: '127.0.0.1', port: fake.port, implicitTls: false, timeoutMs: 3_000 },
      envelope,
    );
    assert.ok(fake.transcript.includes('MAIL FROM:<no-reply@avexpay.net>'));
  });

  test('credentials are never sent in plaintext', async () => {
    /**
     * The security property of this file. A password that sends mail as us is not handed to a
     * server that did not offer encryption, however the conversation is going — the alternative
     * is a credential on the wire on any network between here and the provider.
     */
    const fake = await start({ script: { EHLO: '250-fake\r\n250 AUTH PLAIN LOGIN\r\n' } });

    await assert.rejects(
      sendMail(
        {
          host: '127.0.0.1',
          port: fake.port,
          implicitTls: false,
          username: 'apikey',
          password: 'super-secret',
          timeoutMs: 3_000,
        },
        envelope,
      ),
      (error: unknown) => error instanceof SmtpError && /STARTTLS/.test(error.message),
    );

    assert.ok(
      !fake.transcript.some((line) => line.startsWith('AUTH')),
      'no AUTH may be attempted before the connection is encrypted',
    );
    assert.ok(
      !fake.transcript.join('\n').includes('super-secret'),
      'and the password must not appear on the wire at all',
    );
  });

  test('a rejected recipient is an error, not a silent success', async () => {
    // A 550 here means the address does not exist or we are not allowed to send to it. Treating
    // it as sent would leave a merchant waiting for a mail that was refused.
    const fake = await start({
      script: { EHLO: '250 fake\r\n', 'RCPT TO': '550 no such user\r\n' },
    });

    await assert.rejects(
      sendMail(
        { host: '127.0.0.1', port: fake.port, implicitTls: false, timeoutMs: 3_000 },
        envelope,
      ),
      (error: unknown) => error instanceof SmtpError && /expected 250/.test(error.message),
    );
  });

  test('a newline in a recipient is refused before anything is sent', async () => {
    /**
     * Header injection, which is how a signup form becomes a way to mail strangers. The address
     * comes from whoever filled in the form, so this is untrusted input reaching a protocol
     * where a line break changes the meaning of the message.
     */
    const fake = await start({ script: { EHLO: '250 fake\r\n' } });

    await assert.rejects(
      sendMail({ host: '127.0.0.1', port: fake.port, implicitTls: false, timeoutMs: 3_000 }, {
        ...envelope,
        to: 'victim@example.test\r\nBcc: everyone@example.test',
      }),
      (error: unknown) => error instanceof SmtpError && /line break/.test(error.message),
    );

    assert.deepEqual(fake.transcript, [], 'not a single command should have been sent');
  });

  test('an unreachable server fails rather than hanging', async () => {
    const fake = await start({});
    const port = fake.port;
    await fake.close();

    await assert.rejects(
      sendMail({ host: '127.0.0.1', port, implicitTls: false, timeoutMs: 1_000 }, envelope),
    );
  });
});

describe('reading SMTP_URL', () => {
  test('the shape a deployment actually writes', () => {
    assert.deepEqual(parseSmtpUrl('smtps://user:pass@mail.example.com'), {
      host: 'mail.example.com',
      port: 465,
      implicitTls: true,
      username: 'user',
      password: 'pass',
    });

    // 587 is the submission port, and the default when TLS is negotiated rather than implicit.
    assert.equal(parseSmtpUrl('smtp://mail.example.com').port, 587);
    assert.equal(parseSmtpUrl('smtp://mail.example.com:2525').port, 2525);
  });

  test('a password with punctuation in it survives', () => {
    /**
     * Ordinary, and the failure is confusing: an undecoded password authenticates with the
     * wrong string, the server answers "authentication failed", and whoever is deploying goes
     * looking at the provider's dashboard rather than at the URL they pasted.
     */
    const config = parseSmtpUrl('smtps://user%40example.com:p%40ss%2Fword@mail.example.com');
    assert.equal(config.username, 'user@example.com');
    assert.equal(config.password, 'p@ss/word');
  });

  test('verification is only skipped when the URL asks for it', () => {
    assert.equal(parseSmtpUrl('smtps://mail.example.com').insecureTls, undefined);
    assert.equal(parseSmtpUrl('smtps://mail.example.com?insecure=true').insecureTls, true);
  });

  test('anything that is not SMTP is refused at startup', () => {
    // Rather than at the first message, which would be the first signup.
    for (const url of ['https://mail.example.com', 'not-a-url', 'smtp://']) {
      assert.throws(() => parseSmtpUrl(url), SmtpError, url);
    }
  });
});

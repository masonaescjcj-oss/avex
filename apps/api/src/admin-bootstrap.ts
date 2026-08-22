import type { Readable } from 'node:stream';

import { createDatabase } from './db/client.js';
import { AuditService } from './domain/audit.js';
import { StaffAuthError, StaffAuthService } from './domain/staff-auth.js';
import { loadEnv } from './env.js';

/**
 * Create the first admin account, once, from a shell.
 *
 * `npm run admin:bootstrap --workspace @avex/api`
 *
 * ## Why this is a command and not a route
 *
 * `StaffAuthService.bootstrap` creates a superadmin only while the staff table is empty, and it
 * is deliberately not reachable over HTTP: an endpoint that mints a superadmin is one that has
 * to be right about being closed forever, and the way not to have that problem is not to have
 * the endpoint. So the first account is created by somebody who already holds the database
 * credentials, which is the authority the account represents anyway.
 *
 * Before this, nothing outside a test called it. A fresh deployment therefore had an admin panel
 * nobody could ever sign in to: no staff row, no way to make one, and nothing anywhere saying
 * so. That is the failure this closes.
 *
 * ## The password is never an argument or a variable
 *
 * An argument is in the shell history and visible in `ps` to every user on the host for as long
 * as the command runs. An environment variable is in `/proc/<pid>/environ` and in any crash
 * report the process writes. So it is read from the terminal with the echo off, or piped in.
 */

// -- input -------------------------------------------------------------------

/** The three keys a raw-mode reader has to know about, since the terminal no longer handles them. */
const ESCAPE = '\u001b';
const INTERRUPT = '\u0003';
const BACKSPACE = '\u007f';

/**
 * Read one answer from a terminal, a byte at a time.
 *
 * Raw mode rather than `readline`, for the visible answers and the secret alike, so there is one
 * code path. It also means this owns the echo, which is the point: a password typed at a prompt
 * that echoes is in the scrollback, in a screen share, and over the shoulder of whoever is
 * standing there.
 *
 * Raw mode turns off the terminal's line discipline, so ^C no longer raises SIGINT and has to be
 * handled here. Otherwise the one key everybody trusts to abort would type a character instead.
 */
function askTty(prompt: string, secret: boolean): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();

    let answer = '';
    const finish = (): void => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
    };

    const onData = (chunk: string): void => {
      // An arrow key arrives as an escape sequence; without this, its letters get typed.
      if (chunk.startsWith(ESCAPE)) return;

      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          finish();
          resolve(answer);
          return;
        }
        if (character === INTERRUPT) {
          finish();
          process.exit(130);
        }
        if (character === BACKSPACE || character === '\b') {
          if (answer.length > 0) {
            answer = answer.slice(0, -1);
            // Back up, paint a space over the character, back up again.
            if (!secret) process.stderr.write('\b \b');
          }
          continue;
        }
        // Any remaining control byte is not an answer.
        if (character < ' ') continue;

        answer += character;
        if (!secret) process.stderr.write(character);
      }
    };

    process.stdin.on('data', onData);
  });
}

/**
 * The three answers, from a terminal or from a pipe.
 *
 * The piped case reads **all** of stdin before taking anything from it, and that is not an
 * incidental choice. Asking a `readline` interface one question at a time works on a terminal,
 * where lines arrive as they are typed, and loses answers on a pipe, where every line arrives in
 * one chunk before the second question has been asked. The third answer is then waited for
 * forever, the event loop empties, and the command exits reporting success having created
 * nothing. That is how the first version of this file behaved.
 */
export interface Answers {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

export async function readAnswers(
  input: Readable & { isTTY?: boolean } = process.stdin,
): Promise<Answers> {
  if (input.isTTY === true) {
    return {
      email: (await askTty('email: ', false)).trim(),
      name: (await askTty('name: ', false)).trim(),
      password: await askTty('password (at least 14 characters, not shown): ', true),
    };
  }

  const text = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
    });
    input.on('end', () => resolve(buffer));
    input.on('error', reject);
  });

  const [email = '', name = '', password = ''] = text.split('\n');
  return {
    email: email.trim(),
    name: name.trim(),
    // Only the trailing carriage return, because every other character may be the password.
    password: password.replace(/\r$/, ''),
  };
}

// -- the command -------------------------------------------------------------

async function main(): Promise<void> {
  const env = loadEnv();

  /**
   * The direct connection, not the pooled one.
   *
   * One insert would survive a transaction pooler. It is this way because the operator running
   * this has usually just applied the migrations with `DIRECT_DATABASE_URL` set and nothing
   * else, and failing on a variable they set correctly would teach the wrong lesson.
   */
  const { db, close } = createDatabase(env.DIRECT_DATABASE_URL ?? env.DATABASE_URL, {
    prepare: env.DATABASE_PREPARE,
    max: 1,
  });

  try {
    const { email, name, password } = await readAnswers();
    if (email.length === 0) throw new Error('an email is required');

    const staffAuth = new StaffAuthService(db, new AuditService(db));
    const created = await staffAuth.bootstrap(email, name.length > 0 ? name : email, password);

    /**
     * The secret is printed once and never again, to stdout, so the prompts above went to stderr
     * and are not in the output if it is redirected to a file.
     *
     * There is no route that returns it. An authenticator not enrolled from this text means
     * starting over, and the bootstrap path is closed by then, so starting over means deleting
     * the row by hand. Said plainly for that reason.
     */
    process.stdout.write(
      `\ncreated superadmin ${email}\n  id: ${created.staffId}\n\n` +
        'Enrol this in an authenticator app now. It is shown once and cannot be recovered:\n\n' +
        `  ${created.totpUri}\n\n` +
        `  secret, if the app wants it typed: ${created.totpSecret}\n\n` +
        'Signing in without a working authenticator returns an enrolment challenge and no\n' +
        'session, so this step is not optional. Then sign in at /admin.\n',
    );
  } finally {
    await close();
  }
}

if (process.argv[1]?.endsWith('admin-bootstrap.js')) {
  main().catch(onFailure);
}

function onFailure(error: unknown): never {
  if (error instanceof StaffAuthError && error.code === 'bootstrap_closed') {
    /**
     * Not worth a stack trace. It means the account already exists, which is the state this
     * command exists to reach, and further accounts are created from the panel by the
     * superadmin who is already there.
     */
    process.stderr.write(
      'An admin account already exists, so this command is closed. Create further accounts\n' +
        'from the panel: POST /admin/staff, as a superadmin.\n',
    );
    process.exit(2);
  }

  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

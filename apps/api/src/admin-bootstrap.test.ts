import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { readAnswers } from './admin-bootstrap.js';

/**
 * The input half of `admin:bootstrap`, tested without a terminal or a database.
 *
 * Worth its own file for one reason: the first version of that command asked a `readline`
 * interface three questions in turn, which works on a terminal and loses answers on a pipe —
 * every line arrives in one chunk, the third question is asked after the last line has already
 * been emitted, and the promise never settles. The event loop then empties and the process exits
 * **zero**, having created nothing and reported success.
 *
 * So the case below is not "reads three lines". It is "reads three lines that arrived together",
 * which is the only case a pipe produces and the one the obvious implementation fails.
 */

/** A pipe, faithfully: everything in one chunk, then end. */
function piped(text: string): Readable & { isTTY?: boolean } {
  return Readable.from([text], { objectMode: false });
}

describe('admin bootstrap input', () => {
  test('reads three answers delivered as a single chunk', async () => {
    const answers = await readAnswers(piped('admin@avexpay.net\nAVEX Operator\ncorrect-horse\n'));

    assert.deepEqual(answers, {
      email: 'admin@avexpay.net',
      name: 'AVEX Operator',
      password: 'correct-horse',
    });
  });

  test('reads answers delivered one chunk at a time', async () => {
    const input = Readable.from(['a@b.co\n', 'Name\n', 'secret\n']);

    assert.deepEqual(await readAnswers(input), {
      email: 'a@b.co',
      name: 'Name',
      password: 'secret',
    });
  });

  test('keeps every character of the password except a trailing carriage return', async () => {
    /**
     * Trimming a password is not tidying, it is changing it: the account is created with one
     * value and every later login sends the other, so the operator is locked out of the panel
     * they just created with the password they know is right.
     *
     * A carriage return is the exception, and only at the end, because a file written on Windows
     * or a heredoc through some shells ends its lines with one.
     */
    const answers = await readAnswers(piped('a@b.co\nName\n  pass\rword\ttab  \r\n'));

    // The interior one survives and only the last is dropped, which is what "trailing" means.
    assert.equal(answers.password, '  pass\rword\ttab  ');
  });

  test('an absent name comes back empty rather than undefined', async () => {
    // Only two lines. The command falls back to the email, and must not read `undefined`.
    const answers = await readAnswers(piped('a@b.co\n'));

    assert.equal(answers.name, '');
    assert.equal(answers.password, '');
  });

  test('surrounding whitespace is removed from the email and the name', async () => {
    const answers = await readAnswers(piped('  a@b.co  \n  Name  \nsecret\n'));

    assert.equal(answers.email, 'a@b.co');
    assert.equal(answers.name, 'Name');
  });
});

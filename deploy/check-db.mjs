/**
 * Does this connection string work, and can it do what we need it to do?
 *
 * Run through `deploy/install.sh --check-db`, which asks for the strings with the echo off.
 * Nothing is written and nothing is kept: the one statement that changes anything is a
 * `CREATE TYPE` inside a transaction that is always rolled back.
 *
 * ## Why a real statement and not just a connection
 *
 * A connection proving it can connect proves almost nothing about the failure this deployment
 * actually hits. `CREATE TYPE` through a transaction-mode pooler fails while `select 1` through
 * the same pooler succeeds — so a check that stops at "connected" passes for exactly the
 * configuration that will break the migration, and the migration's own error looks like a syntax
 * mistake in a file that is correct.
 *
 * So the direct string is asked to create a type and roll it back. That is the migration's
 * hardest requirement, in one round trip, leaving nothing behind.
 */

import postgres from 'postgres';

const [role, url] = process.argv.slice(2);
if (!role || !url) {
  process.stderr.write('usage: node check-db.mjs <pooled|direct> <connection string>\n');
  process.exit(2);
}

/** Never the string itself: it holds the password, and this output gets pasted into chats. */
const where = (() => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}`;
  } catch {
    return 'an unparseable connection string';
  }
})();

const say = (mark, text) => process.stdout.write(`  ${mark} ${text}\n`);

/**
 * A short timeout on purpose.
 *
 * The interesting failure here is a Supabase direct endpoint that resolves to IPv6 only, reached
 * from a host with no outbound IPv6 — and that presents as a hang, not a refusal. Ten seconds is
 * long enough to be a real attempt and short enough that nobody assumes it is still thinking.
 */
const sql = postgres(url, {
  max: 1,
  prepare: false,
  connect_timeout: 10,
  idle_timeout: 5,
  onnotice: () => {},
});

let failed = false;

try {
  const [row] = await sql`select version() as version, current_database() as db`;
  say('ok', `connected to ${where}`);
  say('ok', `database "${row.db}", ${String(row.version).split(' ').slice(0, 2).join(' ')}`);

  if (role === 'direct') {
    /**
     * The whole point of the direct string.
     *
     * Rolled back rather than dropped: a rollback cannot leave the type behind even if this
     * process is killed between the two statements, where a CREATE followed by a DROP can.
     */
    const ROLLBACK = 'avex-probe-rollback';
    await sql
      .begin(async (tx) => {
        await tx`create type avex_connection_probe as enum ('ok')`;
        // Throwing is how `begin` is told to roll back. The type never exists outside this
        // transaction, and cannot be left behind if the process dies mid-way.
        throw new Error(ROLLBACK);
      })
      .catch((error) => {
        if (error instanceof Error && error.message === ROLLBACK) return;
        throw error;
      });
    say('ok', 'CREATE TYPE works, so the migrations will run');
  } else {
    say('ok', 'good enough for the request path; migrations use the other string');
  }
} catch (error) {
  failed = true;
  const message = error instanceof Error ? error.message : String(error);
  say('FAILED', `${where}: ${message}`);

  /**
   * The three failures worth naming, because none of their messages name themselves.
   */
  if (/CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(message)) {
    say('', 'Nothing answered. On Supabase the *direct* endpoint is IPv6-only unless the IPv4');
    say('', 'add-on is enabled, and a host without outbound IPv6 gets exactly this. Use the');
    say('', 'session pooler on port 5432 instead — it is IPv4 and still runs CREATE TYPE.');
    say('', "Test this host's IPv6 with: curl -6 -sS --max-time 5 https://supabase.com");
  } else if (/password|authentication|SASL/i.test(message)) {
    say('', 'The host answered and refused the credentials. The password is the database');
    say('', 'password, not your Supabase account password; reset it under');
    say('', 'Project Settings -> Database if you do not have it.');
  } else if (/cannot be executed|prepared statement|CREATE TYPE|transaction/i.test(message)) {
    say('', 'Connected, but it cannot create a type — which is what every migration here needs.');
    say('', 'This is a transaction-mode pooler. Use the direct or session string on port 5432.');
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    say('', 'The hostname did not resolve. Check it against the dashboard, and check this');
    say('', "host's DNS with: getent hosts <that hostname>");
  }
} finally {
  await sql.end({ timeout: 5 });
}

process.exit(failed ? 1 : 0);

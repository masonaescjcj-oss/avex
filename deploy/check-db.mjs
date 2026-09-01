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
/**
 * Anything this throws, as one readable line.
 *
 * Not a formality. postgres.js errors can carry a raw byte array of the server's reply, and Node's
 * default report for an uncaught one is the object — which reaches a person as ninety-three
 * numbers and a stack trace, and tells them nothing about their connection string. This is the
 * only thing that ever reaches the terminal.
 */
const readable = (error) => {
  if (error instanceof Error && typeof error.message === 'string') return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error)?.slice(0, 200) ?? String(error);
  } catch {
    return String(error);
  }
};

/**
 * Whether the host can be reached at all, before a connection is attempted.
 *
 * This exists because of a real finding rather than a hypothetical. A Supabase project's *direct*
 * endpoint — `db.<ref>.supabase.co` — publishes an AAAA record and no A record unless the IPv4
 * add-on is bought. On a host with no outbound IPv6 that produces a ten-second silence and then
 * `CONNECT_TIMEOUT`, which names neither IPv6 nor the add-on nor the fix, and which looks
 * identical to a wrong password or a firewall.
 *
 * Resolving first turns that into a sentence. The pooler hostnames do publish A records, which is
 * why the advice is to use the session pooler rather than to buy anything.
 */
async function reachability(hostname) {
  const dns = await import('node:dns/promises');

  /**
   * `lookup`, not `resolve`.
   *
   * `dns.resolve` talks to the nameservers and ignores everything else the system knows, so it
   * reports `localhost` as unresolvable — which it is, in DNS, and is not in any sense that
   * matters. `lookup` goes through the same resolver the driver itself will use, including
   * /etc/hosts, which makes its answer the one worth acting on.
   */
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, why: 'unresolvable' };
  }
  if (addresses.length === 0) return { ok: false, why: 'unresolvable' };
  if (addresses.some((entry) => entry.family === 4)) return { ok: true };

  /**
   * IPv6 only. Whether that is a problem depends on this machine, so it is measured rather than
   * assumed: a host with working IPv6 reaches it fine and needs no warning.
   */
  const { createConnection } = await import('node:net');
  const localIpv6 = await new Promise((resolve) => {
    const socket = createConnection({ host: '2001:4860:4860::8888', port: 53, family: 6 });
    const settle = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(4000);
    socket.on('connect', () => settle(true));
    socket.on('timeout', () => settle(false));
    socket.on('error', () => settle(false));
  });

  return localIpv6 ? { ok: true } : { ok: false, why: 'ipv6-only' };
}

let sql;
let failed = false;

const hostname = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
})();

if (hostname) {
  const reach = await reachability(hostname);
  if (reach.why === 'ipv6-only') {
    say('FAILED', `${where} publishes no IPv4 address, and this host has no working IPv6.`);
    say('', 'This is the Supabase *direct* endpoint. It is IPv6-only unless the IPv4 add-on is');
    say('', 'enabled on the project, so nothing here can reach it — the connection would sit');
    say('', 'silent for ten seconds and then time out, saying nothing about addresses.');
    say('', '');
    say('', 'Use the SESSION POOLER instead. In the dashboard:');
    say('', '  Project Settings -> Database -> Connection string -> Session pooler');
    say('', 'Its hostname looks like aws-N-<region>.pooler.supabase.com and it does publish');
    say('', 'IPv4. Being session mode, it runs CREATE TYPE, so migrations work through it.');
    process.exit(1);
  }
  if (reach.why === 'unresolvable') {
    say('FAILED', `${where} does not resolve at all — check the hostname against the dashboard.`);
    process.exit(1);
  }
}

try {
  /**
   * Constructed inside the try, which it was not.
   *
   * `postgres()` parses the URL eagerly, so a string that is not a URL at all threw here, outside
   * any handler, and Node printed the parser's own stack. The commonest way to get that is a
   * password containing an unencoded character — which is exactly the person this check exists to
   * help.
   *
   * A short timeout on purpose: the interesting failure is a Supabase direct endpoint that is
   * IPv6-only, reached from a host with no outbound IPv6, and that presents as a hang rather than
   * a refusal.
   */
  sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
  });

  const [row] = await sql`select version() as version, current_database() as db`;
  say('ok', `connected to ${where}`);
  say('ok', `database "${row.db}", ${String(row.version).split(' ').slice(0, 2).join(' ')}`);

  if (role === 'direct') {
    /**
     * The whole point of the direct string, and rolled back rather than dropped: a rollback
     * cannot leave the type behind even if this process is killed between two statements.
     */
    const ROLLBACK = 'avex-probe-rollback';
    await sql
      .begin(async (tx) => {
        await tx`create type avex_connection_probe as enum ('ok')`;
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
  const message = readable(error);
  say('FAILED', `${where}: ${message}`);

  /** The failures worth naming, because none of their messages name themselves. */
  if (/Invalid URL/i.test(message)) {
    say('', 'That is not a valid connection string. The usual cause is a special character in');
    say('', 'the password: an @ must be written %40, a / as %2F, a : as %3A, a # as %23.');
    say('', 'It should look like:');
    say('', '  postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres');
  } else if (/CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(message)) {
    say('', 'Nothing answered. On Supabase the *direct* endpoint is IPv6-only unless the IPv4');
    say('', 'add-on is enabled, and a host without outbound IPv6 gets exactly this. Use the');
    say('', 'session pooler on port 5432 instead — it is IPv4 and still runs CREATE TYPE.');
    say('', "Test this host's IPv6 with: curl -6 -sS --max-time 5 https://supabase.com");
  } else if (/password|authentication|SASL/i.test(message)) {
    say('', 'The host answered and refused the credentials. The password is the database');
    say('', 'password, not your Supabase account password and not an API key; reset it under');
    say('', 'Project Settings -> Database if you do not have it.');
  } else if (/cannot be executed|prepared statement|CREATE TYPE|transaction/i.test(message)) {
    say('', 'Connected, but it cannot create a type — which every migration here needs.');
    say('', 'This is a transaction-mode pooler. Use the direct or session string on port 5432.');
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    say('', 'The hostname did not resolve. Check it against the dashboard, and check this');
    say('', "host's DNS with: getent hosts <that hostname>");
  }
} finally {
  // Closing can throw too, and a failure to hang up must not become the reported problem.
  try {
    await sql?.end({ timeout: 5 });
  } catch {
    /* nothing worth saying: the connection is going away either way */
  }
}

process.exit(failed ? 1 : 0);

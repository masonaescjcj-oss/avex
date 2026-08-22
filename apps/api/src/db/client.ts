import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>['db'];

/**
 * The handle inside `db.transaction(async (tx) => …)`.
 *
 * Named so a service can take one as a parameter. Most here do their work in a callback and
 * let the type be inferred, which is fine when the transaction begins and ends in one method.
 * It is not fine when a method's guarantee depends on the caller's transaction still being
 * open — the wallet allocator holds an advisory lock for exactly that reason — and a parameter
 * is how that requirement gets stated in the signature instead of in a comment.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Whether this connection string points at a transaction-mode pooler.
 *
 * A guess, and a deliberately narrow one: the two markers below are what managed Postgres
 * providers actually use — Supabase's Supavisor listens on 6543 and lives under
 * `pooler.supabase.com`. Guessing wrong in this direction only costs prepared statements;
 * guessing wrong the other way produces `prepared statement "s1" does not exist`, which
 * names nothing in this codebase and sends somebody hunting through the ORM.
 *
 * `DATABASE_PREPARE` overrides it, because a heuristic about somebody else's hostnames is
 * not something to be stuck with.
 */
export function looksPooled(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return url.port === '6543' || url.hostname.includes('pooler.');
  } catch {
    return false;
  }
}

export interface DatabaseOptions {
  /** Force prepared statements on or off. Inferred from the URL when absent. */
  readonly prepare?: boolean | undefined;
  /**
   * Pool size.
   *
   * Lower behind a pooler than in front of one: the provider's own limit is shared across
   * every instance, and ten per instance is how three instances exhaust a small plan and
   * start refusing connections in the request path.
   */
  readonly max?: number | undefined;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}) {
  const prepare = options.prepare ?? !looksPooled(connectionString);

  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    prepare,
    // Money handling reads timestamps constantly; keeping them as Date objects
    // rather than strings avoids a class of timezone parsing mistakes.
    transform: { undefined: null },
  });

  return {
    db: drizzle(sql, { schema }),
    /** Reported at boot, so a misdiagnosed pooler is visible in the first log line. */
    prepare,
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}

export { schema };

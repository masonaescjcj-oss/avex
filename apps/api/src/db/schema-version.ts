import { readFile } from 'node:fs/promises';

import { sql } from 'drizzle-orm';

import type { Database } from './client.js';

/**
 * Whether the database has caught up with the code that is about to run against it.
 *
 * This exists because of a specific outage, and the shape of that outage is the argument for
 * it. A release added one column and the migration did not reach the server. The API started
 * perfectly, `/health` was green, prices were green, reads were green — and one route answered
 * `500 internal_error` to every request, with the real cause (`column "reference_active" does
 * not exist`) visible only in the service log, which the person debugging did not have. It took
 * a day and two people to find, and the server never once said the one thing it knew: that its
 * schema was two migrations behind its code.
 *
 * A process that knows it cannot work should say so at the moment it starts, not discover it
 * one route at a time under a customer's payment.
 *
 * ## How it knows
 *
 * `drizzle-kit` records every applied migration in `drizzle.__drizzle_migrations`, stamping
 * `created_at` with the `when` from the build's own `_journal.json`. So the two can be compared
 * exactly rather than by counting: a migration whose timestamp is in the journal and not in the
 * table has not run, and can be named.
 *
 * ## What it does not do
 *
 * It does not check that the *columns* are right — only that every migration this build ships
 * has been applied. A database edited by hand can still disagree with the code, and nothing
 * here would notice. The point is not to verify the schema; it is to catch the one failure that
 * actually happens, which is a deploy that shipped code without its migration.
 */

export interface SchemaState {
  /** Migrations in this build. */
  readonly expected: number;
  /** Migrations the database has recorded. */
  readonly applied: number;
  /** Those in the build that the database has not run, oldest first. */
  readonly missing: readonly string[];
  /**
   * Whether any missing migration is *older* than the newest one applied.
   *
   * It changes the remedy, which is why it is carried rather than inferred by the caller.
   * `drizzle-kit migrate` applies only what is newer than the last row it finds, so a gap in
   * the middle is not repaired by running it — telling somebody to run it would send them to
   * watch a command say "applied successfully" and change nothing.
   */
  readonly gap: boolean;
  /**
   * Migrations the database has and this build does not — an older build against a newer
   * database, which is a rollback rather than a mistake and is reported without complaint.
   */
  readonly ahead: number;
  /** Null when the journal could not be read, which is not a verdict either way. */
  readonly checked: boolean;
}

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

/**
 * The journal, beside the migrations this build ships.
 *
 * Resolved from this module's own location rather than the working directory: the service is
 * started by systemd, whose `WorkingDirectory` is nobody's business here.
 */
const JOURNAL = new URL('../../migrations/meta/_journal.json', import.meta.url);

export async function schemaState(db: Database): Promise<SchemaState> {
  let entries: JournalEntry[];
  try {
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as { entries?: JournalEntry[] };
    entries = journal.entries ?? [];
  } catch {
    /**
     * No journal, no opinion.
     *
     * A bundle that ships the compiled code without the migrations folder is a legitimate way
     * to deploy — the serverless entry point is one — and refusing to start there would turn a
     * safety check into an outage of its own.
     */
    return { expected: 0, applied: 0, missing: [], gap: false, ahead: 0, checked: false };
  }

  let applied: { created_at: string | number | null }[];
  try {
    const rows = await db.execute(
      sql`select created_at from drizzle.__drizzle_migrations order by created_at`,
    );
    applied = rows as unknown as { created_at: string | number | null }[];
  } catch {
    /**
     * The table is absent on a database no migration has ever touched, which is a fresh
     * install about to be migrated rather than a server that is behind.
     */
    return { expected: entries.length, applied: 0, missing: [], gap: false, ahead: 0, checked: false };
  }

  const stamps = new Set(applied.map((row) => String(row.created_at)));
  const absent = entries.filter((entry) => !stamps.has(String(entry.when))).sort((a, b) => a.idx - b.idx);

  const newestApplied = applied.reduce(
    (highest, row) => Math.max(highest, Number(row.created_at) || 0),
    0,
  );

  return {
    expected: entries.length,
    applied: applied.length,
    missing: absent.map((entry) => entry.tag),
    gap: absent.some((entry) => entry.when < newestApplied),
    ahead: Math.max(0, applied.length - (entries.length - absent.length)),
    checked: true,
  };
}

/** What to print, and whether to refuse to start. Separated so `/health` can say it too. */
export function schemaComplaint(state: SchemaState): string | null {
  if (!state.checked || state.missing.length === 0) return null;
  const remedy = state.gap
    ? 'One of them is older than the newest migration the database has recorded, so ' +
      '`npm run db:migrate` will not apply it — the tool only runs what is newer than the last ' +
      'row it finds, and would report success having done nothing. Apply that file by hand, or ' +
      'find out who edited drizzle.__drizzle_migrations.'
    : 'Apply them with: npm run db:migrate --workspace @avex/api (or re-run deploy/install.sh).';

  return (
    `the database is ${state.missing.length} migration(s) behind this build: ` +
    `${state.missing.join(', ')}. ` +
    'Routes that touch the new columns will answer 500 and nothing else will look wrong. ' +
    remedy
  );
}

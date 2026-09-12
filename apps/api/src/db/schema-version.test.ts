import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sql } from 'drizzle-orm';

import { createDatabase } from './client.js';
import { schemaComplaint, schemaState } from './schema-version.js';

/**
 * The guard against shipping code without its migration.
 *
 * Written after that happened. A release added one column, the migration did not reach the
 * server, and the result was not a failure to start — it was a server that looked entirely
 * healthy while one route answered `500 internal_error` to every request. `/health` was green.
 * Prices were green. Reads were green. The real cause, `column "reference_active" does not
 * exist`, was in the service log and nowhere else, and the people debugging it were working
 * over HTTP. It cost a day.
 *
 * Everything here is about the one question that would have ended it in a second: does this
 * database have the migrations this build was written against?
 */

const databaseUrl = process.env.DATABASE_URL;

describe('schema version', { skip: databaseUrl ? false : 'DATABASE_URL is not set' }, () => {
  let close: () => Promise<void>;
  let db: ReturnType<typeof createDatabase>['db'];

  before(() => {
    const database = createDatabase(databaseUrl!);
    close = database.close;
    db = database.db;
  });

  after(async () => {
    await close?.();
  });

  test('a database with every migration has nothing to say', async () => {
    const state = await schemaState(db);
    assert.equal(state.checked, true, 'the journal beside this build was found');
    assert.ok(state.expected > 0, 'this build ships migrations');
    assert.deepEqual(state.missing, [], `not migrated: ${state.missing.join(', ')}`);
    assert.equal(schemaComplaint(state), null);
  });

  test('a migration the database has not run is named, not counted', async () => {
    /**
     * Named, because "two behind" sends somebody to `git log` and a name sends them to the
     * file. The row is removed and put back rather than a fixture being invented: the shape
     * of what `drizzle-kit` writes is the thing being relied on, and a hand-made fixture
     * would keep agreeing with itself after the real one changed.
     */
    const [newest] = (await db.execute(
      sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
    )) as unknown as { created_at: string | number }[];
    assert.ok(newest, 'the migrations table has rows');

    await db.execute(
      sql`delete from drizzle.__drizzle_migrations where created_at = ${String(newest!.created_at)}::bigint`,
    );

    try {
      const state = await schemaState(db);
      assert.equal(state.missing.length, 1, 'exactly the one that was removed');
      assert.match(state.missing[0]!, /^\d{4}_/, `a migration's own name: ${state.missing[0]}`);

      const complaint = schemaComplaint(state);
      assert.ok(complaint);
      // The three things the person reading it needs: what, what it will look like, and the fix.
      assert.match(complaint, new RegExp(state.missing[0]!));
      assert.match(complaint, /500/);
      /**
       * The gap case, and the trap it avoids. The row removed above is the newest, so the
       * remedy is the ordinary one — but a migration missing from the *middle* is not fixed
       * by `db:migrate` at all: the tool applies only what is newer than the last row it
       * finds, and reports success having done nothing. Sending somebody to run it would
       * cost them the afternoon this whole file exists to save.
       */
      assert.equal(state.gap, false, 'the newest was removed, so there is no gap');
      assert.match(complaint, /db:migrate|install\.sh/);
    } finally {
      await db.execute(
        sql`insert into drizzle.__drizzle_migrations (hash, created_at)
            values ('restored-by-schema-version-test', ${String(newest!.created_at)}::bigint)`,
      );
    }

    // And the database is whole again, or every later test in this suite is a lie.
    assert.deepEqual((await schemaState(db)).missing, []);
  });

  test('a database ahead of the build is not a complaint', async () => {
    /**
     * That is a rollback: an older build against a newer database. It may be deliberate, the
     * code does not touch what it does not know about, and refusing to start would turn a
     * planned rollback into an outage.
     */
    const future = String(Date.now() + 86_400_000);
    await db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at)
          values ('a-migration-from-the-future', ${future}::bigint)`,
    );

    try {
      const state = await schemaState(db);
      assert.deepEqual(state.missing, []);
      assert.equal(schemaComplaint(state), null);
      assert.ok(state.ahead >= 1, 'and it is noticed, even though it is not a problem');
    } finally {
      await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = ${future}::bigint`);
    }
  });

  test('a migration missing from the middle is not sent to db:migrate', async () => {
    /**
     * `drizzle-kit migrate` applies what is newer than the newest row it finds, so a hole in
     * the middle survives it — the command says "applied successfully" and changes nothing.
     * Advice that does not work is worse than none: it costs a cycle of running it, believing
     * it, and looking elsewhere.
     */
    const rows = (await db.execute(
      sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 2`,
    )) as unknown as { created_at: string | number }[];
    assert.equal(rows.length, 2, 'at least two migrations to make a hole between');
    const middle = String(rows[1]!.created_at);

    await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = ${middle}::bigint`);
    try {
      const state = await schemaState(db);
      assert.equal(state.gap, true);
      const complaint = schemaComplaint(state)!;
      assert.match(complaint, /older than the newest/);
      assert.match(complaint, /having done nothing/);
    } finally {
      await db.execute(
        sql`insert into drizzle.__drizzle_migrations (hash, created_at)
            values ('restored-by-schema-version-test', ${middle}::bigint)`,
      );
    }
    assert.deepEqual((await schemaState(db)).missing, []);
  });
});

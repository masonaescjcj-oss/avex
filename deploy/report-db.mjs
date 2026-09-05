/**
 * Is the database the schema this build expects?
 *
 * Run through `deploy/install.sh --report`, which supplies the connection string from
 * `api.env` so it never has to be typed or pasted. Nothing is written.
 *
 * ## Why the whole schema and not a version number
 *
 * `drizzle.__drizzle_migrations` says which files were applied, which is the right answer
 * when migrations are the only thing that ever touched the database. It is the wrong answer
 * in every case where somebody pointed the API at a database that was restored, recreated,
 * or — this happened — belonged to another project entirely, where the table exists, the
 * name matches and the columns do not.
 *
 * So the check is a diff: every table and column the committed schema snapshot describes,
 * against what the server actually has. A missing column is the failure that produces a
 * 500 on one endpoint and nothing anywhere else, which is the hardest kind to find by
 * reading logs.
 *
 * ## Both connection strings, not one
 *
 * `DATABASE_URL` is what the API answers requests on and `DIRECT_DATABASE_URL` is what the
 * migrations run through. They are normally the same database, and when they are not, this
 * is the report that has to say so: migrations applied to one while the API reads the
 * other produces a schema that passes every check and an endpoint that still fails. So
 * each distinct string is checked, and the request one is checked first, because that is
 * the one a merchant's 500 came out of.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const META = join(here, '..', 'apps', 'api', 'migrations', 'meta');

/** The latest committed snapshot: what this checkout's code expects to find. */
function expectedSchema() {
  const snapshots = readdirSync(META)
    .filter((name) => /^\d+_snapshot\.json$/.test(name))
    .sort();
  const latest = snapshots[snapshots.length - 1];
  if (latest === undefined) throw new Error(`no schema snapshot in ${META}`);

  const snapshot = JSON.parse(readFileSync(join(META, latest), 'utf8'));
  const tables = new Map();
  for (const table of Object.values(snapshot.tables ?? {})) {
    tables.set(table.name, new Set(Object.keys(table.columns ?? {})));
  }
  return { source: latest, tables };
}

/** Host and database only. The string holds a password and this output gets pasted. */
function where(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return 'an unparseable connection string';
  }
}

const requestUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DIRECT_DATABASE_URL;
if (!requestUrl && !migrationUrl) {
  process.stderr.write('neither DATABASE_URL nor DIRECT_DATABASE_URL is set\n');
  process.exit(2);
}

const expected = expectedSchema();
process.stdout.write(`    schema expected by  ${expected.source}\n`);

/** The strings to check: the request path first, and the migration path if it differs. */
const targets = [];
if (requestUrl) targets.push(['requests', requestUrl]);
if (migrationUrl && migrationUrl !== requestUrl) targets.push(['migrations', migrationUrl]);
if (targets.length === 2 && where(targets[0][1]) === where(targets[1][1])) {
  // Same host and database, different credentials or options. Worth saying, not worth
  // checking twice — the schema is the same schema.
  process.stdout.write('    note                both strings point at the same database\n');
  targets.pop();
}

let worst = 0;
for (const [role, url] of targets) {
  const status = await check(role, url);
  if (status > worst) worst = status;
}
process.exit(worst);

/** Report on one connection string. Returns 0 fine, 1 wrong schema, 2 unreachable. */
async function check(role, url) {
  process.stdout.write(`    ${role.padEnd(19)} ${where(url)}\n`);

  // `prepare: false` so this works through a transaction pooler as well as a direct
  // connection: the point is to report on whatever string the API itself is using.
  const sql = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 2, prepare: false });

  try {
    /**
     * Only a missing table means "never migrated". Anything else — a refused password, a
     * host that went away — has to keep travelling: swallowing it here printed "none" for a
     * database nothing had even connected to, which reads as a fact about the schema.
     */
    const applied = await sql`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `.catch((error) => {
      if (error?.code === '42P01' || error?.code === '3F000') return [{ count: null }];
      throw error;
    });

    process.stdout.write(
      applied[0].count === null
        ? '    migrations applied  none — this database has never been migrated\n'
        : `    migrations applied  ${applied[0].count}\n`,
    );

    const rows = await sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
    `;

    const live = new Map();
    for (const row of rows) {
      if (!live.has(row.table_name)) live.set(row.table_name, new Set());
      live.get(row.table_name).add(row.column_name);
    }

    const missingTables = [];
    const missingColumns = [];
    for (const [table, columns] of expected.tables) {
      const found = live.get(table);
      if (found === undefined) {
        missingTables.push(table);
        continue;
      }
      const absent = [...columns].filter((column) => !found.has(column));
      if (absent.length > 0) missingColumns.push(`${table}.${absent.join(', ')}`);
    }

    if (missingTables.length === 0 && missingColumns.length === 0) {
      process.stdout.write(
        `    schema              matches: all ${expected.tables.size} tables, every column\n`,
      );
      return 0;
    }

    /**
     * Most of it missing means the wrong database, not a missed migration — and the
     * difference decides what to do about it: migrating an unrelated database would create
     * this schema inside somebody else's project.
     *
     * Half, rather than all of it, because the overlap is never zero. A database belonging
     * to another product had `users` and `checkout_sessions` — the same names, none of the
     * same columns — and reporting that as two behind migrations would have been the wrong
     * instruction with a plausible reason attached.
     *
     * `foreign` is how many tables here are none of our business. An empty database is
     * missing everything too, and telling somebody to stop pointing at their empty
     * database would be exactly the wrong instruction — what it needs is the migrations.
     */
    const foreign = live.size - (expected.tables.size - missingTables.length);

    if (missingTables.length * 2 >= expected.tables.size && foreign >= 5) {
      process.stdout.write(
        `    schema              NOT THIS DATABASE — ${missingTables.length} of ` +
          `${expected.tables.size} tables are absent.\n` +
          `                        It holds ${live.size} tables of its own. The API is pointed at\n` +
          '                        the wrong database; migrating it would not fix that, and\n' +
          "                        would write this schema into whatever project it is.\n",
      );
      return 1;
    }

    // Capped, because a screenful of table names buries the line that says what to do.
    const shown = missingTables.slice(0, 8);
    for (const table of shown) process.stdout.write(`    missing table       ${table}\n`);
    if (missingTables.length > shown.length) {
      process.stdout.write(`                        and ${missingTables.length - shown.length} more\n`);
    }
    for (const entry of missingColumns.slice(0, 8)) {
      process.stdout.write(`    missing column      ${entry}\n`);
    }
    process.stdout.write(
      '    schema              BEHIND this build. Run the migrations:\n' +
        '                        sudo bash deploy/install.sh   (its Database step does it)\n',
      );
      return 1;
  } catch (error) {
    process.stdout.write(`    schema              could not be read: ${readable(error, url)}\n`);
    return 2;
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

/** Errors as a sentence, and never with the connection string in them. */
function readable(error, url) {
  const code = error?.code ?? '';
  const message = String(error?.message ?? error).replace(/:\/\/[^@\s]*@/g, '://***@');
  if (code === 'CONNECT_TIMEOUT') return `${where(url)} did not answer`;
  if (code === 'ENOTFOUND') return `${where(url)} does not resolve`;
  if (code === 'ECONNREFUSED') return `${where(url)} refused the connection`;
  if (code === '28P01') return 'the password was refused';
  if (code === '3D000') return 'that database does not exist';
  return code ? `${code}: ${message}` : message;
}

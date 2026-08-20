import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    /**
     * `DIRECT_DATABASE_URL` first, and it matters.
     *
     * Managed Postgres is usually fronted by a transaction-mode pooler, which hands each
     * statement whichever backend is free. That is fine for the request path and wrong for
     * migrations: this schema creates enums, and `CREATE TYPE` through a transaction pooler
     * fails in a way that reads like a syntax error in the migration rather than a
     * connection problem. Falls back to `DATABASE_URL`, which is the same string on a plain
     * Postgres.
     */
    url:
      process.env.DIRECT_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgres://avex:avex@localhost:5432/avex',
  },
  // Migrations are reviewed and committed, never applied straight from a schema
  // diff. A money system's schema changes belong in code review.
  strict: true,
  verbose: true,
});

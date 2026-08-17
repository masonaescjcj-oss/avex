import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://avex:avex@localhost:5432/avex',
  },
  // Migrations are reviewed and committed, never applied straight from a schema
  // diff. A money system's schema changes belong in code review.
  strict: true,
  verbose: true,
});

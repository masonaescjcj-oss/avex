import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>['db'];

export function createDatabase(connectionString: string) {
  const sql = postgres(connectionString, {
    max: 10,
    // Money handling reads timestamps constantly; keeping them as Date objects
    // rather than strings avoids a class of timezone parsing mistakes.
    transform: { undefined: null },
  });

  return {
    db: drizzle(sql, { schema }),
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}

export { schema };

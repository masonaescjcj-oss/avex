import { createDatabase } from './db/client.js';
import { AuditService } from './domain/audit.js';
import { AuthService } from './domain/auth-service.js';
import { loadEnv } from './env.js';
import { buildServer } from './http/server.js';
import { ConsoleMailer } from './mailer.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDatabase(env.DATABASE_URL);

  const audit = new AuditService(db);
  const auth = new AuthService(db, audit, {
    sessionTtlMs: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
    emailTokenTtlMs: env.EMAIL_TOKEN_TTL_MINUTES * 60 * 1000,
  });

  const app = buildServer({
    env,
    db,
    auth,
    audit,
    // Phase 6 replaces this with a real transport; the seam is what matters now.
    mailer: new ConsoleMailer(env.APP_URL),
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

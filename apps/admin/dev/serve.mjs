/**
 * Serve the API and the admin panel from one origin, for local verification.
 *
 * In production the panel has its own origin — that separation is the whole point of
 * the subdomain plan. Here they share one so a browser can reach both without CORS
 * getting in the way of looking at the page.
 */
import { readFileSync } from 'node:fs';
import { createDatabase } from '../../api/dist/db/client.js';
import { AuditService } from '../../api/dist/domain/audit.js';
import { AuthService } from '../../api/dist/domain/auth-service.js';
import { StaffAuthService } from '../../api/dist/domain/staff-auth.js';
import { AdminService } from '../../api/dist/domain/admin-service.js';
import { SettlementStore } from '../../api/dist/domain/settlement-store.js';
import { ReconciliationService } from '../../api/dist/domain/reconciliation-service.js';
import { PayoutAddressService } from '../../api/dist/domain/payout-service.js';
import { AssetService } from '../../api/dist/domain/asset-service.js';
import { loadEnv } from '../../api/dist/env.js';
import { ConsoleMailer } from '../../api/dist/mailer.js';
import { buildServer } from '../../api/dist/http/server.js';
import { ContractProbe, DEFAULT_AGGREGATION, DEFAULT_BREAKER, PriceService } from '@avex/core';

const env = loadEnv({ ...process.env, NODE_ENV: 'test', RATE_LIMIT_PER_MINUTE: '100000' });
const { db } = createDatabase(env.DATABASE_URL);
const audit = new AuditService(db);
const mailer = new ConsoleMailer(env.APP_URL, () => {});
const offline = { async getCode() { throw new Error('offline'); }, async call() { throw new Error('offline'); }, async getStorageAt() { throw new Error('offline'); } };
const settlements = new SettlementStore(db);
const reconciliation = new ReconciliationService(db, audit, { async recompute() { return 'paid'; } });

const app = buildServer({
  env, db, audit, mailer,
  minPriceSources: DEFAULT_AGGREGATION.minSources,
  payouts: new PayoutAddressService(db, audit, mailer),
  assets: new AssetService(db, audit, new ContractProbe(offline), ['USDT']),
  prices: new PriceService([{ name: 'fake', supports: () => true, async fetchUsdPrice() { return { priceScaled: 10n ** 18n, observedAt: Date.now() }; } }], { aggregation: DEFAULT_AGGREGATION, breaker: DEFAULT_BREAKER, cacheTtlMs: 10_000 }),
  auth: new AuthService(db, audit, { sessionTtlMs: 3600e3, emailTokenTtlMs: 3600e3 }),
  staffAuth: new StaffAuthService(db, audit),
  settlements, reconciliation,
  admin: new AdminService(db, audit, settlements, reconciliation),
});

/**
 * A front server that serves the panel and forwards API calls into the Fastify app.
 *
 * The API refuses `/` — default-deny on every route not explicitly public — which is
 * correct and is why the page cannot just be registered on it. In production the
 * panel is a static file on its own origin with the API behind a proxy; this mirrors
 * that shape closely enough to exercise the real request path.
 */
import { createServer } from 'node:http';

const page = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const document = `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${page}</body></html>`;

await app.ready();

createServer((request, response) => {
  const url = request.url ?? '/';
  if (url === '/' || url.startsWith('/?')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(document);
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', async () => {
    const injected = await app.inject({
      method: request.method,
      url,
      headers: request.headers,
      payload: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });
    response.writeHead(injected.statusCode, injected.headers);
    response.end(injected.rawPayload);
  });
}).listen(4310, '127.0.0.1', () => console.log('listening on http://127.0.0.1:4310'));

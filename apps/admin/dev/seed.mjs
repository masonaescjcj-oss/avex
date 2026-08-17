/**
 * Seed a demo dataset for driving the panel locally.
 *
 * Refuses to run against anything but a local database. This creates a superadmin
 * with a known password, which is exactly the kind of script that must never reach a
 * real deployment — so the check is here rather than in a warning comment nobody
 * reads at the moment it matters.
 */
const target = process.env.DATABASE_URL ?? '';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(target)) {
  console.error('refusing to seed: DATABASE_URL must point at 127.0.0.1 or localhost');
  process.exit(1);
}

import { randomBytes } from 'node:crypto';
import { createDatabase, schema } from '../../api/dist/db/client.js';
import { AuditService } from '../../api/dist/domain/audit.js';
import { AuthService } from '../../api/dist/domain/auth-service.js';
import { StaffAuthService } from '../../api/dist/domain/staff-auth.js';
import { SettlementStore } from '../../api/dist/domain/settlement-store.js';
import { ReconciliationService } from '../../api/dist/domain/reconciliation-service.js';

const url = 'postgresql://postgres:postgres@127.0.0.1:5455/avex';
const { db, close } = createDatabase(url);
const audit = new AuditService(db);
const staffAuth = new StaffAuthService(db, audit);
const auth = new AuthService(db, audit, { sessionTtlMs: 3600e3, emailTokenTtlMs: 3600e3 });
const settlements = new SettlementStore(db);
const reconciliation = new ReconciliationService(db, audit, { async recompute() { return 'paid'; } });

const u = randomBytes(3).toString('hex');
const password = 'demo-admin-password-1';

// A superadmin to sign in as.
let created;
try {
  created = await staffAuth.bootstrap(`root-${u}@avex.test`, 'Root Operator', password);
} catch {
  const [any] = await db.select({ id: schema.staff.id }).from(schema.staff).limit(1);
  created = await staffAuth.createStaff({ staffId: any.id, role: 'superadmin' }, `root-${u}@avex.test`, 'Root Operator', password, 'superadmin');
}

// Merchants, one suspended.
const shops = ['Portals Market', 'Nova Gaming', 'Kian Digital', 'Aria Subscriptions'];
const orgIds = [];
for (const [i, name] of shops.entries()) {
  const signup = await auth.signup(`owner-${u}-${i}@example.com`, 'a-sufficiently-long-password', `${name} ${u}`);
  orgIds.push(signup.organizationId);
}
// Suspend just one, by id.
const { eq } = await import('drizzle-orm');
await db.update(schema.organizations)
  .set({ suspendedAt: new Date(), suspendedReason: 'Chargeback pattern under review; contact support to resolve.' })
  .where(eq(schema.organizations.id, orgIds[2]));

// Assets: two awaiting review with findings, one approved.
const mk = (symbol, verdict, findings, requiresFixedRate = false) =>
  db.insert(schema.assets).values({
    chain: 'bsc', symbol, contract: `0x${randomBytes(20).toString('hex')}`,
    decimals: 18, kind: 'erc20', verdict, findings, requiresFixedRate, probedAt: new Date(),
    submittedByOrganizationId: verdict === 'review' ? orgIds[0] : null,
  }).returning({ id: schema.assets.id });

const [usdt] = await mk('USDT', 'approved', []);
await mk('KIANX', 'review', [
  { check: 'erc20_interface', result: 'absent', detail: 'symbol, decimals and transfer all present' },
  { check: 'fee_on_transfer', result: 'present', detail: 'simulated transfer delivered 99% of the amount' },
  { check: 'proxy', result: 'present', detail: 'EIP-1967 implementation slot is set' },
], true);
await mk('NOVA', 'review', [
  { check: 'erc20_interface', result: 'absent', detail: 'conforms' },
  { check: 'blacklist', result: 'unknown', detail: 'no matching selector found, but bytecode is obfuscated' },
]);

// Invoices and one unmatched transfer per shape.
const deposit = `0x${randomBytes(20).toString('hex')}`;
const [invoice] = await db.insert(schema.invoices).values({
  organizationId: orgIds[0], assetId: usdt.id,
  amountDue: (20n * 10n ** 18n).toString(), chain: 'bsc',
  depositAddress: deposit, payoutAddress: `0x${randomBytes(20).toString('hex')}`,
  expiresAt: new Date(Date.now() + 3600e3), reference: 'ORD-4417',
}).returning({ id: schema.invoices.id });

await reconciliation.record({
  chain: 'ton', txHash: `0x${randomBytes(32).toString('hex')}`, transferIndex: 0,
  amount: 20_020_000n, toAddress: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
  fromAddress: 'EQpayer_wallet_address_here_000000000000000000', blockNumber: 44_120_991,
  reason: 'memo_missing',
});
await reconciliation.record({
  chain: 'bsc', txHash: `0x${randomBytes(32).toString('hex')}`, transferIndex: 0,
  amount: 20n * 10n ** 18n, toAddress: deposit, fromAddress: `0x${randomBytes(20).toString('hex')}`,
  blockNumber: 45_119_002, reason: 'invoice_expired', assetId: usdt.id,
});
await reconciliation.record({
  chain: 'bsc', txHash: `0x${randomBytes(32).toString('hex')}`, transferIndex: 1,
  amount: 1_000_000_000_000_000n, toAddress: `0x${randomBytes(20).toString('hex')}`,
  blockNumber: 45_119_040, reason: 'no_matching_address',
});

// Settlements, including a stuck one and a replacement pair.
const stuckHash = `0x${randomBytes(32).toString('hex')}`;
await settlements.recordBroadcast({ chain: 'bsc', txHash: stuckHash, nonce: 812, invoiceIds: [invoice.id], feePerGasWei: 1_050_000_000n, gasLimit: 145_000n, estimatedCostUsdMicros: 15_200n, broadcastAt: new Date(Date.now() - 22 * 60e3) });
const okHash = `0x${randomBytes(32).toString('hex')}`;
await settlements.recordBroadcast({ chain: 'bsc', txHash: okHash, nonce: 811, invoiceIds: [invoice.id], feePerGasWei: 1_000_000_000n, gasLimit: 140_000n, estimatedCostUsdMicros: 14_100n, broadcastAt: new Date(Date.now() - 40 * 60e3) });
await settlements.recordReceipt('bsc', okHash, { status: 'success', gasUsed: 121_400n, actualCostUsdMicros: 13_900n });
const oldHash = `0x${randomBytes(32).toString('hex')}`;
const newHash = `0x${randomBytes(32).toString('hex')}`;
await settlements.recordBroadcast({ chain: 'polygon', txHash: oldHash, nonce: 77, invoiceIds: [], feePerGasWei: 30_000_000_000n, gasLimit: 120_000n, estimatedCostUsdMicros: 4_200n, broadcastAt: new Date(Date.now() - 9 * 60e3) });
await settlements.recordBroadcast({ chain: 'polygon', txHash: newHash, nonce: 77, invoiceIds: [], feePerGasWei: 34_500_000_000n, gasLimit: 120_000n, estimatedCostUsdMicros: 4_800n, broadcastAt: new Date(Date.now() - 7 * 60e3) });
await settlements.recordReplacement('polygon', oldHash, newHash);
const revertedHash = `0x${randomBytes(32).toString('hex')}`;
await settlements.recordBroadcast({ chain: 'ton', txHash: revertedHash, nonce: 4, invoiceIds: [], feePerGasWei: 0n, gasLimit: 1n, estimatedCostUsdMicros: 0n });
await settlements.recordReceipt('ton', revertedHash, { status: 'reverted', gasUsed: 0n });

// Watcher state: one healthy, one lagging, one erroring, others never polled.
for (const [chain, minutesAgo, error] of [['bsc', 0.2, null], ['polygon', 26, null], ['ton', 3, 'eth_getLogs timed out after 10s']]) {
  await db.insert(schema.watchCursors)
    .values({ chain, scannedTo: 45_119_041, lastPolledAt: new Date(Date.now() - minutesAgo * 60e3), lastError: error, lastErrorAt: error ? new Date(Date.now() - 60e3) : null })
    .onConflictDoUpdate({ target: schema.watchCursors.chain, set: { scannedTo: 45_119_041, lastPolledAt: new Date(Date.now() - minutesAgo * 60e3), lastError: error } });
}

console.log(JSON.stringify({ email: `root-${u}@avex.test`, password, totpSecret: created.totpSecret }));
await close();

/**
 * Preview mode: the staff panel driven by canned answers instead of an API.
 *
 * A network stub, not a branch inside the page. Every render path, every request and every
 * error handler runs exactly as it does against the real API — a preview built by
 * short-circuiting the panel's own logic would show a version of it that has never been
 * exercised, which is the opposite of what a preview is for.
 *
 * The fixtures are deliberately not a healthy system. A panel whose whole job is to surface
 * what is wrong, shown with nothing wrong, teaches nobody anything: so there is a chain
 * lagging, an asset waiting on review, an unmatched payment, and a merchant on a negotiated
 * rate. Those are the states an operator opens this panel to act on.
 */

export interface PreviewRoute {
  readonly status: number;
  readonly body: unknown;
}

const NOW = Date.parse('2026-08-18T09:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const ORG_A = 'a1b2c3d4-1111-4111-8111-111111111111';
const ORG_B = 'b2c3d4e5-2222-4222-8222-222222222222';
const ORG_C = 'c3d4e5f6-3333-4333-8333-333333333333';

const CHAINS = [
  {
    chain: 'bsc',
    scannedTo: 41_204_882,
    lastPolledAt: ago(1),
    staleForMs: 60_000,
    settlements: { pending: 2, stuck: 0, blockingNonce: null, spentUsdMicros: '1840000' },
    lastError: null,
  },
  {
    /** Lagging on purpose: a watcher that stopped is the thing this panel exists to show. */
    chain: 'ton',
    scannedTo: 38_991_004,
    lastPolledAt: ago(22),
    staleForMs: 22 * 60_000,
    settlements: { pending: 0, stuck: 0, blockingNonce: null, spentUsdMicros: '0' },
    lastError: 'liteserver timed out after 8s',
  },
  {
    chain: 'tron',
    scannedTo: 66_120_745,
    lastPolledAt: ago(1),
    staleForMs: 45_000,
    settlements: { pending: 0, stuck: 1, blockingNonce: 41, spentUsdMicros: '410000' },
    lastError: null,
  },
];

/**
 * The settlements view counts per chain rather than describing watchers, so its `chains`
 * are a different shape from the health view's. Kept separate rather than merged: one
 * object satisfying two readers is how a fixture ends up with fields neither uses.
 */
const SETTLEMENT_CHAINS = [
  {
    chain: 'bsc',
    pending: 2,
    confirmed: 148,
    reverted: 0,
    replaced: 1,
    stuck: [],
    spentUsdMicros: '1840000',
    spendCapUsdMicros: '25000000',
    blockingNonce: null,
  },
  {
    chain: 'tron',
    pending: 0,
    confirmed: 31,
    reverted: 0,
    replaced: 0,
    /** One stuck, which is what turns this card red and why the fixture has it. */
    stuck: ['a7b8c9d0-7777-4777-8777-777777777777'],
    spentUsdMicros: '410000',
    spendCapUsdMicros: '25000000',
    blockingNonce: 41,
  },
];

export function previewRoutes(): ReadonlyMap<string, PreviewRoute> {
  const ok = (body: unknown): PreviewRoute => ({ status: 200, body });

  return new Map<string, PreviewRoute>([
    [
      'GET /admin/me',
      ok({
        email: 'owner@avex.example',
        role: 'superadmin',
        mfaSatisfiedAt: new Date(NOW).toISOString(),
        permissions: [
          'health:read',
          'merchant:read',
          'merchant:suspend',
          'payment:read',
          'payment:reassign',
          'contract:read',
          'contract:decide',
          'settlement:read',
          'audit:read',
          'staff:write',
          'asset_list:write',
          'webhook:replay',
          'breaker:write',
        ],
      }),
    ],
    [
      'GET /admin/health',
      ok({
        chains: CHAINS,
        reconciliation: { pending: 1, oldestPendingAgeMs: 95 * 60_000 },
        review: { waiting: 1 },
        oracle: { openAssets: [] },
        unavailable: [],
        webhooks: { failedLastHour: 0 },
      }),
    ],
    [
      'GET /admin/merchants',
      ok({
        total: 3,
        items: [
          {
            id: ORG_A,
            name: 'Kian Digital',
            slug: 'kian-digital',
            status: 'active',
            suspendedAt: null,
            memberCount: 2,
            invoiceCount: 43,
            paidVolume: '18420000000',
            lastInvoiceAt: ago(20),
            createdAt: ago(60 * 24 * 40),
          },
          {
            id: ORG_B,
            name: 'Nova Gaming',
            slug: 'nova-gaming',
            status: 'active',
            suspendedAt: null,
            memberCount: 1,
            invoiceCount: 612,
            paidVolume: '294100000000',
            lastInvoiceAt: ago(3),
            createdAt: ago(60 * 24 * 210),
          },
          {
            id: ORG_C,
            name: 'Portals Market',
            slug: 'portals-market',
            status: 'suspended',
            suspendedAt: ago(60 * 24 * 3),
            memberCount: 1,
            invoiceCount: 8,
            paidVolume: '0',
            lastInvoiceAt: null,
            createdAt: ago(60 * 24 * 12),
          },
        ],
      }),
    ],
    [
      'GET /admin/commission/revenue',
      ok({
        creditedUsdMicros: '1268600000',
        settledUsdMicros: '1181500000',
        accounts: [
          {
            organizationId: ORG_B,
            feeBps: 40,
            negotiated: false,
            feePayer: 'payer',
            volumeUsdMicros: '294100000000',
            commissionUsdMicros: '1176400000',
            periodEnd: new Date(NOW + 18 * 24 * 60 * 60_000).toISOString(),
          },
          {
            organizationId: ORG_A,
            feeBps: 50,
            negotiated: false,
            feePayer: 'merchant',
            volumeUsdMicros: '18420000000',
            commissionUsdMicros: '92200000',
            periodEnd: new Date(NOW + 18 * 24 * 60 * 60_000).toISOString(),
          },
          {
            /** Negotiated, and quiet. Exactly the deal an owner should be reviewing. */
            organizationId: ORG_C,
            feeBps: 25,
            negotiated: true,
            feePayer: 'merchant',
            volumeUsdMicros: '0',
            commissionUsdMicros: '0',
            periodEnd: new Date(NOW + 18 * 24 * 60 * 60_000).toISOString(),
          },
        ],
      }),
    ],
    [
      'GET /admin/contracts/review',
      ok({
        items: [
          {
            assetId: 'd4e5f6a7-4444-4444-8444-444444444444',
            symbol: 'KIAN',
            chain: 'bsc',
            contract: '0x9f2c41ab77e05d63c8b1a2049e6d3b8c41ab77e0',
            organizationName: 'Kian Digital',
            requestedAt: ago(60 * 26),
            checks: [
              { name: 'Contract has code', result: 'pass', detail: '4,912 bytes at the address' },
              { name: 'Decimals readable', result: 'pass', detail: '18' },
              { name: 'Symbol matches', result: 'pass', detail: 'KIAN' },
              { name: 'Transfer emits an event', result: 'pass', detail: 'ERC-20 Transfer seen' },
              {
                name: 'Balance is not rewritable by the owner',
                result: 'warn',
                detail: 'A privileged mint function exists. The merchant can inflate their own token.',
              },
            ],
          },
        ],
      }),
    ],
    [
      'GET /admin/unmatched',
      ok({
        pendingTotal: 1,
        rows: [
          {
            id: 'e5f6a7b8-5555-4555-8555-555555555555',
            chain: 'bsc',
            txHash: `0x${'7c'.repeat(32)}`,
            amount: '5000000000000000000',
            assetSymbol: 'USDT',
            assetDecimals: 18,
            toAddress: '0x7A3f9C21bE04D5aa71cE3B8Ed4F9021cC6b17E52',
            fromAddress: '0x2b1e5f4c9a8d7e6f3c2b1a0f9e8d7c6b5a4f3e2d',
            reason: 'no_invoice_for_address',
            resolution: 'pending',
            seenAt: ago(95),
          },
        ],
      }),
    ],
    [
      'GET /admin/settlements',
      ok({
        chains: SETTLEMENT_CHAINS,
        recent: [
          {
            id: 'f6a7b8c9-6666-4666-8666-666666666666',
            chain: 'bsc',
            nonce: 812,
            txHash: `0x${'3a'.repeat(32)}`,
            status: 'confirmed',
            invoiceIds: ['i1', 'i2', 'i3', 'i4'],
            feePerGasWei: '3000000000',
            replacedByTxHash: null,
            broadcastAt: ago(40),
          },
          {
            id: 'a7b8c9d0-7777-4777-8777-777777777777',
            chain: 'tron',
            nonce: 41,
            // A stuck settlement was broadcast — that is what stuck means. It is simply not
            // confirming, and the hash is how an operator goes and looks at it.
            txHash: `0x${'5e'.repeat(32)}`,
            status: 'stuck',
            invoiceIds: ['i5'],
            feePerGasWei: '47000000',
            replacedByTxHash: null,
            broadcastAt: ago(190),
          },
        ],
      }),
    ],
    [
      'GET /admin/audit',
      ok({
        total: 3,
        rows: [
          {
            id: 'b8c9d0e1-8888-4888-8888-888888888888',
            createdAt: ago(12),
            actor: { kind: 'staff', email: 'owner@avex.example' },
            action: 'fee_plan.negotiated',
            organizationName: 'Portals Market',
            targetType: 'fee_plan',
            targetId: ORG_C,
            ip: '203.0.113.9',
          },
          {
            id: 'c9d0e1f2-9999-4999-8999-999999999999',
            createdAt: ago(60 * 4),
            actor: { kind: 'system', email: null },
            action: 'fee_plan.tier_changed',
            organizationName: 'Nova Gaming',
            targetType: 'fee_plan',
            targetId: ORG_B,
            ip: null,
          },
          {
            id: 'd0e1f2a3-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            createdAt: ago(60 * 24 * 3),
            actor: { kind: 'staff', email: 'support@avex.example' },
            action: 'merchant.suspended',
            organizationName: 'Portals Market',
            targetType: 'organization',
            targetId: ORG_C,
            ip: '203.0.113.44',
          },
        ],
      }),
    ],
    [
      `GET /admin/merchants/${ORG_A}`,
      ok({
        organization: {
          id: ORG_A,
          name: 'Kian Digital',
          slug: 'kian-digital',
          suspendedAt: null,
          suspendedReason: null,
          createdAt: ago(60 * 24 * 40),
        },
        members: [
          {
            userId: 'u1',
            email: 'owner@kian.example',
            role: 'owner',
            emailVerifiedAt: ago(60 * 24 * 40),
            totpEnabledAt: ago(60 * 24 * 39),
            joinedAt: ago(60 * 24 * 40),
            revokedAt: null,
          },
          {
            userId: 'u2',
            email: 'dev@kian.example',
            role: 'developer',
            emailVerifiedAt: ago(60 * 24 * 30),
            /** No second factor on a member who can read keys. Worth an operator seeing. */
            totpEnabledAt: null,
            joinedAt: ago(60 * 24 * 30),
            revokedAt: null,
          },
        ],
        payoutAddresses: [
          {
            chain: 'bsc',
            address: '0x7A3f9C21bE04D5aa71cE3B8Ed4F9021cC6b17E52',
            createdAt: ago(60 * 24 * 30),
            supersededAt: null,
          },
          {
            chain: 'bsc',
            address: '0x1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e',
            createdAt: ago(60 * 24 * 40),
            supersededAt: ago(60 * 24 * 30),
          },
        ],
        apiKeys: [
          {
            id: 'k1',
            name: 'staging',
            mode: 'test',
            displayPrefix: 'ak_test_9f2c',
            scopes: ['invoice:create'],
            createdAt: ago(60 * 24 * 9),
            lastUsedAt: ago(30),
            revokedAt: null,
          },
        ],
        recentInvoices: [
          {
            id: '4d2a9c1b-1111-4111-8111-111111111111',
            reference: 'order-1042',
            chain: 'bsc',
            status: 'paid',
            amountDue: '20100502512562814071',
            amountPaid: '20100502512562814071',
            depositAddress: '0x3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b',
            createdAt: ago(180),
            expiresAt: ago(165),
            settledAt: ago(160),
          },
        ],
        invoicesByStatus: { paid: 34, underpaid: 1, pending: 3, expired: 5 },
        commission: {
          plan: { feeBps: 50, negotiatedFee: false },
          commission: {
            feeBps: 50,
            perThousandUsd: 5,
            negotiated: false,
            feePayer: 'merchant',
            nextTier: { bps: 45, fromUsdMicros: '50000000000' },
          },
          ladder: [
            { bps: 50, fromUsdMicros: '0' },
            { bps: 45, fromUsdMicros: '50000000000' },
            { bps: 40, fromUsdMicros: '250000000000' },
          ],
          period: {
            start: ago(60 * 24 * 12),
            end: new Date(NOW + 18 * 24 * 60 * 60_000).toISOString(),
            processedUsdMicros: '18420000000',
            verifiedUsdMicros: '17920000000',
            declaredUsdMicros: '500000000',
            unpricedPayments: 0,
            wouldEarnBps: 50,
          },
        },
        commissionEarned: { creditedUsdMicros: '92200000', settledUsdMicros: '90100000' },
      }),
    ],
  ]);
}

/**
 * Match a request to a fixture. Longest path first, so a specific merchant beats the list.
 *
 * Query strings are dropped: the panel asks for `/admin/merchants?filter=all&limit=25`, and
 * a fixture per query would be a fixture per caller.
 */
export function matchPreview(
  method: string,
  url: string,
  routes: ReadonlyMap<string, PreviewRoute> = previewRoutes(),
): PreviewRoute | null {
  const path = (url.split('?')[0] ?? '').replace(/^https?:\/\/[^/]+/, '');

  let best: { length: number; route: PreviewRoute } | null = null;
  for (const [key, route] of routes) {
    const [keyMethod, keyPath] = key.split(' ');
    if (keyMethod !== method.toUpperCase() || keyPath === undefined) continue;
    if (!path.endsWith(keyPath)) continue;
    if (best === null || keyPath.length > best.length) best = { length: keyPath.length, route };
  }

  return best?.route ?? null;
}

/**
 * Every write, refused with one message.
 *
 * The one place a preview has to decide what a change does, and pretending it succeeded
 * would leave somebody believing they had suspended a merchant or moved a rate.
 */
export const PREVIEW_REFUSAL: PreviewRoute = {
  status: 409,
  body: {
    error: 'preview',
    message: 'This is a preview with canned data — nothing here can be changed.',
  },
};

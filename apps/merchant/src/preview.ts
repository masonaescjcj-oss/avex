/**
 * Preview mode: the dashboard driven by canned answers instead of an API.
 *
 * So the panel can be handed to somebody to click through before there is a server to
 * point it at. Deliberately built as a **network stub**, not as a branch inside the page:
 * every render path, every fetch call and every error handler runs exactly as it does
 * against the real API. A preview implemented by short-circuiting the page's own logic
 * would show a version of the dashboard that has never been exercised.
 *
 * The fixtures are the API's real response shapes. When one of them is wrong the preview
 * breaks in the same way the real thing would, which is the point of keeping them here in
 * typed, tested code rather than as a blob of JSON in the page.
 */

export interface PreviewRoute {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Enough of a merchant to be worth looking at.
 *
 * A half-configured account rather than a perfect one: two currencies approved and one in
 * review, a payout address on one chain but not the other, no webhook endpoint, and a test
 * key but no live key. That is what the setup checklist is *for*, and a preview of a
 * finished account would show every step ticked and teach nobody anything.
 */
const NOW = Date.parse('2026-08-18T09:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const COMMISSION = {
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
    end: ahead(60 * 24 * 18),
    processedUsdMicros: '18420000000',
    verifiedUsdMicros: '17920000000',
    declaredUsdMicros: '500000000',
    unpricedPayments: 0,
    wouldEarnBps: 50,
  },
};

const INVOICES = [
  {
    id: '4d2a9c1b-1111-4111-8111-111111111111',
    reference: 'order-1042',
    mode: 'live',
    chain: 'bsc',
    status: 'paid',
    amountDue: '20100502512562814071',
    amountPaid: '20100502512562814071',
    depositAddress: '0x7A3f9C21bE04D5aa71cE3B8Ed4F9021cC6b17E52',
    memo: null,
    feeBps: 50,
    feePayer: 'merchant',
    amountNet: '20000000000000000000',
    toleranceBps: 50,
    assetSymbol: 'USDT',
    assetDecimals: 18,
    createdAt: ago(180),
    expiresAt: ago(165),
  },
  {
    id: '4d2a9c1b-2222-4222-8222-222222222222',
    reference: 'order-1041',
    mode: 'live',
    chain: 'ton',
    status: 'underpaid',
    amountDue: '9040000000',
    amountPaid: '8000000000',
    depositAddress: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
    memo: 'AVEX-0123456789AB',
    feeBps: 50,
    feePayer: 'merchant',
    amountNet: '8996000000',
    toleranceBps: 50,
    assetSymbol: 'TON',
    assetDecimals: 9,
    createdAt: ago(320),
    expiresAt: ago(305),
  },
  {
    id: '4d2a9c1b-3333-4333-8333-333333333333',
    reference: 'order-1040',
    mode: 'test',
    chain: 'bsc',
    status: 'pending',
    amountDue: '5025125628140703517',
    amountPaid: '0',
    depositAddress: 'AVEXTEST-BSC-9f2c41ab77e05d63c8b1a204',
    memo: null,
    feeBps: 50,
    feePayer: 'payer',
    amountNet: '5000000000000000000',
    toleranceBps: 50,
    assetSymbol: 'USDT',
    assetDecimals: 18,
    createdAt: ago(20),
    expiresAt: ahead(40),
  },
];

/**
 * The routes the dashboard actually calls, and what each answers.
 *
 * Keyed by method and path suffix, because the page builds full URLs from an organisation
 * id — matching on the suffix keeps the fixtures readable without hardcoding that id in
 * eleven places.
 */
export function previewRoutes(): ReadonlyMap<string, PreviewRoute> {
  const ok = (body: unknown): PreviewRoute => ({ status: 200, body });

  return new Map<string, PreviewRoute>([
    ['GET /v1/auth/me', ok({ email: 'you@example.com', userId: 'preview-user' })],
    [
      'GET /v1/organizations',
      ok({ organizations: [{ id: 'preview-org', name: 'Kian Digital', slug: 'kian-digital' }] }),
    ],
    ['GET /commission', ok(COMMISSION)],
    [
      'GET /reports/volume',
      ok({
        volume: [
          { chain: 'bsc', assetSymbol: 'USDT', assetDecimals: 18, paymentCount: 34, total: '17920000000000000000000' },
          { chain: 'ton', assetSymbol: 'TON', assetDecimals: 9, paymentCount: 6, total: '182000000000' },
        ],
        invoicesByStatus: { paid: 34, underpaid: 1, pending: 3, expired: 5 },
      }),
    ],
    [
      /**
       * Every state the currency list can be in, in one response.
       *
       * The point of the Currencies tab is that "off" has six causes and five are not the
       * merchant's to fix. A fixture with three approved rows would show one of them.
       */
      'GET /assets',
      ok({
        data: [
          {
            id: 'a1',
            symbol: 'USDT',
            chain: 'bsc',
            contract: '0x55d398326f99059fF775485246999027B3197955',
            decimals: 18,
            kind: 'erc20',
            curated: true,
            verdict: 'approved',
            listed: true,
            requiresFixedRate: false,
            enabled: true,
            pricingMode: 'fiat',
            fixedRateValidUntil: null,
            spreadBps: 50,
            toleranceBps: 50,
          },
          {
            /** Available and untouched: the row the merchant can actually act on. */
            id: 'a2',
            symbol: 'USDC',
            chain: 'bsc',
            contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
            decimals: 18,
            kind: 'erc20',
            curated: true,
            verdict: 'approved',
            listed: true,
            requiresFixedRate: false,
            enabled: false,
            pricingMode: null,
            fixedRateValidUntil: null,
            spreadBps: null,
            toleranceBps: null,
          },
          {
            /** On, but no payout address on TON — so every invoice is being refused. */
            id: 'a3',
            symbol: 'TON',
            chain: 'ton',
            contract: null,
            decimals: 9,
            kind: 'native',
            curated: true,
            verdict: 'approved',
            listed: true,
            requiresFixedRate: false,
            enabled: true,
            pricingMode: 'fiat',
            fixedRateValidUntil: null,
            spreadBps: 50,
            toleranceBps: 50,
          },
          {
            /** Their own token, still in the review queue. */
            id: 'a4',
            symbol: 'KIAN',
            chain: 'bsc',
            contract: '0x9f2c41ab77e05d63c8b1a2049e6d3b8c41ab77e0',
            decimals: 18,
            kind: 'erc20',
            curated: false,
            verdict: 'review',
            listed: true,
            requiresFixedRate: true,
            enabled: false,
            pricingMode: null,
            fixedRateValidUntil: null,
            spreadBps: null,
            toleranceBps: null,
          },
          {
            /** Vetted, but we have stopped offering it. Nothing the merchant does helps. */
            id: 'a5',
            symbol: 'USDC',
            chain: 'solana',
            contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            decimals: 6,
            kind: 'spl',
            curated: true,
            verdict: 'approved',
            listed: false,
            requiresFixedRate: false,
            enabled: false,
            pricingMode: null,
            fixedRateValidUntil: null,
            spreadBps: null,
            toleranceBps: null,
          },
        ],
      }),
    ],
    [
      'GET /payout-addresses',
      ok({
        addresses: [
          {
            chain: 'bsc',
            address: '0x7A3f9C21bE04D5aa71cE3B8Ed4F9021cC6b17E52',
            activeFrom: ago(60 * 24 * 30),
            supersededAt: null,
          },
        ],
      }),
    ],
    ['GET /webhook-endpoints', ok({ endpoints: [] })],
    [
      'GET /webhook-deliveries',
      ok({ deliveries: [] }),
    ],
    [
      'GET /api-keys',
      ok({
        keys: [
          {
            id: 'k1',
            name: 'staging',
            displayPrefix: 'ak_test_9f2c',
            mode: 'test',
            scopes: ['invoice:create', 'invoice:read'],
            createdAt: ago(60 * 24 * 9),
            revokedAt: null,
          },
        ],
      }),
    ],
    ['GET /invoices', ok({ invoices: INVOICES })],
    [
      'POST /checkouts',
      {
        status: 201,
        body: {
          id: 'c0ffee00-1111-4111-8111-111111111111',
          url: 'https://pay.avex.example/pay/c0ffee00-1111-4111-8111-111111111111',
          receiptUrl: 'https://pay.avex.example/pay/c0ffee00-1111-4111-8111-111111111111/receipt',
          status: 'open',
          mode: 'live',
        },
      },
    ],
    [
      'PUT /assets',
      {
        status: 409,
        body: {
          error: 'preview',
          message: 'This is a preview with canned data — nothing here can be changed.',
        },
      },
    ],
    [
      'POST /assets',
      {
        status: 409,
        body: {
          error: 'preview',
          message: 'This is a preview with canned data — nothing here can be changed.',
        },
      },
    ],
    /**
     * Refused, on purpose.
     *
     * Everything else here is a read. This is the one place the preview has to decide what
     * a write does, and pretending a change succeeded would leave somebody believing they
     * had reconfigured an account that does not exist.
     */
    [
      'POST /commission/fee-payer',
      {
        status: 409,
        body: {
          error: 'preview',
          message: 'This is a preview with canned data — nothing here can be changed.',
        },
      },
    ],
  ]);
}

/**
 * Match a request to a fixture.
 *
 * Longest suffix first, so `/webhook-endpoints` cannot be shadowed by a shorter key that
 * happens to end the same way. Query strings are dropped: the page asks for
 * `/invoices?limit=50`, and a fixture per limit would be a fixture per caller.
 */
export function matchPreview(
  method: string,
  url: string,
  routes: ReadonlyMap<string, PreviewRoute> = previewRoutes(),
): PreviewRoute | null {
  /**
   * A trailing id is dropped before matching.
   *
   * `PUT /v1/organizations/x/assets/a1` is a write against the assets collection, and a
   * fixture per asset id would be a fixture per row. Only the last segment, and only when it
   * looks like an id rather than a path word — `/commission/fee-payer` must keep its tail.
   */
  const path = (url.split('?')[0] ?? '').replace(/\/[0-9a-fA-F-]{2,}$/, (tail) =>
    /^\/[a-z-]+$/.test(tail) ? tail : '',
  );

  let best: { key: string; route: PreviewRoute } | null = null;
  for (const [key, route] of routes) {
    const [keyMethod, keyPath] = key.split(' ');
    if (keyMethod !== method.toUpperCase() || keyPath === undefined) continue;
    if (!path.endsWith(keyPath)) continue;
    if (best === null || keyPath.length > (best.key.split(' ')[1] ?? '').length) {
      best = { key, route };
    }
  }

  return best?.route ?? null;
}

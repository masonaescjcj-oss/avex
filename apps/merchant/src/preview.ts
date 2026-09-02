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

import { CURATED_ASSETS } from '@avex/core';

export interface PreviewRoute {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The merchant's currency list, derived from the real curated catalogue.
 *
 * Written out by hand it showed five entries, and somebody reading the preview reasonably
 * concluded the platform supported three chains. A preview that under-reports the product
 * is worse than none, so the fixture is the list.
 *
 * The per-row states on top are the point of the tab: "off" has six causes and five are not
 * the merchant's to fix, and a fixture where everything was approved and on would show one
 * of them.
 */
export function previewAssets(): readonly unknown[] {
  const priced = new Set(['USDT', 'USDC', 'BNB', 'ETH', 'POL', 'TON', 'SOL', 'TRX']);
  /** Accepting on BSC, and TON is on with no payout address — the row that matters most. */
  const enabled = new Set(['bsc:USDT', 'bsc:BNB', 'ton:USDT']);
  /** Vetted but withdrawn by us: nothing the merchant does changes it. */
  const closedChains = new Set(['solana']);

  const entries = CURATED_ASSETS.map((asset) => {
    const key = `${asset.chain}:${asset.symbol}`;
    const on = enabled.has(key);
    return {
      id: key,
      symbol: asset.symbol,
      chain: asset.chain,
      contract: asset.contract ?? null,
      decimals: asset.decimals,
      kind: asset.kind,
      curated: true,
      verdict: 'approved',
      listed: !closedChains.has(asset.chain),
      issuer: asset.issuer,
      requiresFixedRate: !priced.has(asset.symbol),
      enabled: on,
      pricingMode: on ? 'fiat' : null,
      fixedRateValidUntil: null,
      spreadBps: on ? 50 : null,
      toleranceBps: on ? 50 : null,
    };
  });

  return [
    ...entries,
    {
      /** Their own token, still in the review queue, and nothing prices it. */
      id: 'own:KIAN',
      symbol: 'KIAN',
      chain: 'bsc',
      contract: '0x9f2c41ab77e05d63c8b1a2049e6d3b8c41ab77e0',
      decimals: 18,
      kind: 'erc20',
      curated: false,
      verdict: 'review',
      listed: true,
      // Null, not a guess: their own token has no issuer we can speak for.
      issuer: null,
      requiresFixedRate: true,
      enabled: false,
      pricingMode: null,
      fixedRateValidUntil: null,
      spreadBps: null,
      toleranceBps: null,
    },
  ];
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

const MEMBERS = [
  {
    userId: 'preview-you',
    email: 'you@example.com',
    role: 'owner',
    twoFactorEnabled: true,
    joinedAt: '2026-02-04T09:00:00.000Z',
  },
  {
    userId: 'preview-reza',
    email: 'reza@example.com',
    role: 'developer',
    /**
     * Deliberately off. It is the difference between a member who can be phished out of the
     * payout address and one who cannot, and a preview where everybody is protected would
     * never show that column meaning anything.
     */
    twoFactorEnabled: false,
    joinedAt: '2026-06-18T11:30:00.000Z',
  },
];

const INVITES = [
  {
    id: 'inv-live',
    email: 'sara@example.com',
    role: 'admin',
    invitedAt: '2026-08-17T08:00:00.000Z',
    expiresAt: '2026-08-24T08:00:00.000Z',
    invitedBy: 'you@example.com',
    expired: false,
  },
  {
    id: 'inv-stale',
    email: 'old-contractor@example.com',
    role: 'viewer',
    invitedAt: '2026-07-01T08:00:00.000Z',
    expiresAt: '2026-07-08T08:00:00.000Z',
    invitedBy: 'you@example.com',
    expired: true,
  },
];

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

/**
 * A balance with something owed on it, deliberately.
 *
 * The preview's job is to show the panel as it looks when it has something to say. A zero
 * balance hides the block entirely — which is the right behaviour for a real account that has
 * never taken a TRON payment, and useless for showing what the block does.
 */
const BALANCE = {
  balanceUsdMicros: '-320000',
  creditLimitUsdMicros: '500000000',
  canInvoiceOnAccruingChains: true,
  entries: [
    { id: 'led-1', kind: 'accrual', amountUsdMicros: '-500000', invoiceId: null, note: null, createdAt: ago(60 * 30) },
    { id: 'led-2', kind: 'recovery', amountUsdMicros: '180000', invoiceId: null, note: null, createdAt: ago(60 * 12) },
  ],
};

/**
 * A pool with one live wallet and one waiting out its delay.
 *
 * Both rows, because they are the two states the panel renders differently — and the pending
 * one carries the Cancel control that the whole twenty-four hours exists for.
 */
const WALLETS = {
  wallets: [
    {
      id: 'w1',
      chain: 'tron',
      address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      label: 'main',
      retiredAt: null,
    },
  ],
  pending: [
    {
      id: 'wc1',
      chain: 'tron',
      address: 'TWKxbjHnf3EY3mZvYUcaLLxLBnMhqUXsQ4',
      effectiveAt: ahead(60 * 19),
    },
  ],
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
    /**
     * With the two flags the security tab reads. A fixture that left them out would leave
     * the panel guessing, and the guess it makes for a missing `totpEnabled` is "off" —
     * which is the state worth previewing anyway: the tab exists to be walked through by
     * somebody who has not set an authenticator up yet.
     */
    [
      'GET /v1/auth/me',
      ok({
        email: 'you@example.com',
        userId: 'preview-user',
        emailVerified: true,
        totpEnabled: false,
        mfaComplete: true,
      }),
    ],

    /**
     * Enrolment, both halves.
     *
     * A real secret and a real `otpauth://` URI, because the page draws the URI as a QR
     * with the same encoder the checkout uses — a placeholder that did not encode would
     * show an empty frame in the preview and look like a bug in the panel. The recovery
     * codes are formatted like real ones for the same reason.
     */
    [
      'POST /v1/auth/totp/enroll',
      ok({
        secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        uri:
          'otpauth://totp/AVEX%20Pay:you%40example.com' +
          '?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=AVEX+Pay',
        status: 'pending_confirmation',
      }),
    ],
    [
      'POST /v1/auth/totp/confirm',
      ok({
        status: 'enabled',
        recoveryCodes: [
          'K7QW-2M4D-9XZP-4R6T',
          'B3VH-8YNC-5JQK-7WLD',
          'M9XT-4KRB-2PGF-6HSN',
          'T5CQ-7WMJ-3ZDV-9YKB',
          'R2NF-6HPL-8XSW-4MQT',
          'V8JD-3RKG-7CNZ-2PWH',
          'H4WS-9LQB-6MTV-3XKF',
          'P6ZK-2CVN-4JHT-8WRQ',
          'D9MQ-5XPW-7KBS-2VHL',
          'W3TF-8QNJ-6RCK-9ZMP',
        ],
      }),
    ],
    /** 204 in the real thing, and the page reads nothing from it. */
    ['POST /v1/auth/mfa', ok({ status: 'ok' })],
    ['POST /v1/auth/sessions/revoke-others', { status: 204, body: null }],

    /**
     * The two calls that get somebody *in*, rather than the ones the dashboard makes once it
     * is already there.
     *
     * The landing page's "create an account" button sends people to the form, so the form has
     * to be walkable in a preview — otherwise the only way into the preview is the one path a
     * real visitor never takes, and the screen they were actually sent to goes untested.
     *
     * The signup answer is the real one's shape: no session, and no hint about whether the
     * address was already taken.
     */
    ['POST /v1/auth/signup', { status: 201, body: { emailVerificationRequired: true } }],
    /**
     * And the link the signup email carries, so the confirmation screen is reachable in a
     * preview too. The token is not checked here — what a preview has to show is the page
     * somebody lands on, and that page is the same one either way.
     */
    ['POST /v1/auth/verify-email', ok({ verified: true })],
    [
      'POST /v1/auth/login',
      ok({ status: 'ok', token: 'preview', expiresAt: '2027-01-01T00:00:00.000Z' }),
    ],
    [
      'GET /v1/organizations',
      // With a role, because the team page draws differently for a viewer than an owner and
      // a preview that showed the read-only version would be previewing the wrong product.
      ok({
        organizations: [
          { id: 'preview-org', name: 'Kian Digital', slug: 'kian-digital', role: 'owner' },
        ],
      }),
    ],

    /**
     * A team part-way through being assembled: two people in, one invitation waiting and one
     * that nobody acted on and has since expired.
     *
     * The expired row is the point. It is the state that used to be invisible — an
     * invitation that quietly vanished on its expiry, leaving somebody sure they had sent
     * one — so a preview without it would be showing a tab that always looks tidy.
     */
    ['GET /members', ok({ data: MEMBERS })],
    ['GET /invites', ok({ data: INVITES })],
    ['POST /members', { status: 202, body: { status: 'invited', id: 'inv-new', superseded: 0 } }],
    ['GET /commission', ok(COMMISSION)],
    ['GET /balance', ok(BALANCE)],
    ['GET /deposit-wallets', ok(WALLETS)],
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
    ['GET /assets', ok({ data: previewAssets() })],
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
    /**
     * Adding or retiring a wallet, refused for the same reason.
     *
     * A preview that accepted these would be the worst kind: the merchant would believe they
     * had registered an address their customers were about to be asked to pay.
     */
    [
      'POST /deposit-wallets',
      {
        status: 409,
        body: {
          error: 'preview',
          message: 'This is a preview with canned data — no wallet can be added.',
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

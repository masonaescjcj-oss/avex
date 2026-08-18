import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PREVIEW_REFUSAL, matchPreview, previewRoutes } from './preview.js';
import { NAV } from './permissions.js';

/**
 * The staff panel's preview fixtures.
 *
 * The router's own behaviour is pinned in the merchant panel's equivalent test; what
 * matters here is coverage and shape. A section that opens on "could not load" is a preview
 * that makes the panel look broken, and the panel's whole job is to be the thing you trust
 * when something is broken.
 */

describe('the preview fixtures', () => {
  const routes = previewRoutes();

  test('every section the nav offers can be opened', () => {
    /**
     * Driven from `NAV` rather than a hand-written list, so adding a section to the panel
     * without a fixture fails here instead of showing an operator an error page.
     */
    const paths: Record<string, string> = {
      health: '/admin/health',
      merchants: '/admin/merchants?filter=all&limit=25',
      revenue: '/admin/commission/revenue',
      catalogue: '/admin/assets',
      unmatched: '/admin/unmatched?resolution=pending&limit=100',
      review: '/admin/contracts/review?limit=100',
      settlements: '/admin/settlements?limit=60',
      audit: '/admin/audit?limit=100',
    };

    for (const item of NAV) {
      const path = paths[item.id];
      assert.ok(path, `${item.id} has no preview path listed`);
      assert.ok(matchPreview('GET', path!, routes) !== null, `${item.id} has no fixture`);
    }
  });

  test('the signed-in staff member can reach every section', () => {
    // A preview whose fixture lacked a permission would hide a section, and the missing
    // section would read as the panel not having it at all.
    const me = matchPreview('GET', '/admin/me', routes)?.body as { permissions: string[] };
    for (const item of NAV) {
      if (item.requires === undefined) continue;
      assert.ok(me.permissions.includes(item.requires), `${item.id} needs ${item.requires}`);
    }
  });

  test('a merchant can be drilled into from the list', () => {
    // The list rows are clickable, so a fixture for the list without one for the detail
    // would give a preview where the first thing anybody tries is an error.
    const list = matchPreview('GET', '/admin/merchants', routes)?.body as {
      items: { id: string }[];
    };
    const first = list.items[0]!;
    assert.ok(matchPreview('GET', `/admin/merchants/${first.id}`, routes) !== null);
  });

  test('the fixture system has something wrong with it', () => {
    /**
     * Deliberate. A panel whose whole job is to surface what is wrong, shown with nothing
     * wrong, teaches nobody anything — so the fixtures carry a lagging watcher, an asset
     * waiting on review and an unresolved payment. Those are the states an operator opens
     * this panel to act on.
     */
    const health = matchPreview('GET', '/admin/health', routes)?.body as {
      chains: { staleForMs: number | null; lastError: string | null }[];
      reconciliation: { pending: number };
      review: { waiting: number };
    };
    assert.ok(
      health.chains.some((chain) => (chain.staleForMs ?? 0) > 5 * 60_000),
      'a lagging watcher is the thing this panel exists to show',
    );
    assert.ok(health.chains.some((chain) => chain.lastError !== null));
    assert.ok(health.reconciliation.pending > 0);
    assert.ok(health.review.waiting > 0);
  });

  test('the catalogue has a vetted asset we are not offering', () => {
    /**
     * The state the whole section exists for, and the one a fixture of a healthy catalogue
     * would not show: a contract we trust on a chain we are not ready for. Listing and
     * verdict are separate columns precisely so that state can be represented honestly.
     */
    const catalogue = matchPreview('GET', '/admin/assets', routes)?.body as {
      assets: { verdict: string; listed: boolean; symbol: string; chain: string }[];
    };
    const held = catalogue.assets.find((asset) => asset.verdict === 'approved' && !asset.listed);
    assert.ok(held, 'a vetted-but-unlisted asset should be in the fixture');
    assert.equal(held!.chain, 'solana');
    // And one waiting on review, so both non-accepting states appear.
    assert.ok(catalogue.assets.some((asset) => asset.verdict === 'review'));
  });

  test('the revenue book has a negotiated account in it', () => {
    // The rung the ladder is not moving, which is the deal an owner should be reviewing and
    // the one case the Revenue table marks.
    const book = matchPreview('GET', '/admin/commission/revenue', routes)?.body as {
      accounts: { negotiated: boolean; feePayer: string }[];
    };
    assert.ok(book.accounts.some((account) => account.negotiated));
    // And one account passing the commission to its customers, so both readings of that
    // column appear.
    assert.ok(book.accounts.some((account) => account.feePayer === 'payer'));
  });

  test('the book total is the sum of its accounts', () => {
    // The same property the real service is tested for. A headline disagreeing with the
    // list beneath it would look like a panel bug to whoever is evaluating the panel.
    const book = matchPreview('GET', '/admin/commission/revenue', routes)?.body as {
      creditedUsdMicros: string;
      settledUsdMicros: string;
      accounts: { commissionUsdMicros: string }[];
    };
    const summed = book.accounts.reduce(
      (total, account) => total + BigInt(account.commissionUsdMicros),
      0n,
    );
    assert.equal(book.creditedUsdMicros, summed.toString());
    assert.ok(BigInt(book.settledUsdMicros) <= BigInt(book.creditedUsdMicros));
  });

  test('every write is refused with one message', () => {
    // Suspending a merchant or moving a rate in a preview must not appear to work.
    assert.equal(PREVIEW_REFUSAL.status, 409);
    assert.match(JSON.stringify(PREVIEW_REFUSAL.body), /nothing here can be changed/);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SUPPORTED_CHAINS } from '../chains/registry.js';
import {
  CURATED_ASSETS,
  CURATED_GAPS,
  EXPECTED_STABLECOINS,
  bridgedAssets,
  curatedCoverage,
  openCuratedWork,
  curatedForChain,
  findCuratedAsset,
  isCurated,
  symbolClaimedElsewhere,
} from './registry.js';

test('no chain and contract pair appears twice', () => {
  // A duplicate would make `findCuratedAsset` return whichever came first, which
  // is how a wrong decimals value reaches production.
  const seen = new Set<string>();
  for (const asset of CURATED_ASSETS) {
    const key = `${asset.chain}:${asset.contract?.toLowerCase() ?? 'native'}`;
    assert.ok(!seen.has(key), `duplicate curated entry: ${key}`);
    seen.add(key);
  }
});

test('every curated entry is well-formed', () => {
  for (const asset of CURATED_ASSETS) {
    assert.ok(SUPPORTED_CHAINS.includes(asset.chain), `${asset.symbol}: unsupported chain`);
    assert.ok(asset.decimals >= 0 && asset.decimals <= 36, `${asset.symbol}: bad decimals`);
    assert.ok(asset.note.length > 0, `${asset.symbol}: undocumented entry`);

    if (asset.kind === 'native') {
      assert.equal(asset.contract, undefined, `${asset.symbol}: native must have no contract`);
    } else {
      assert.ok(asset.contract, `${asset.symbol}: non-native needs a contract`);
    }
  }
});

test('each chain has exactly one native asset', () => {
  for (const chain of SUPPORTED_CHAINS) {
    const natives = curatedForChain(chain).filter((asset) => asset.kind === 'native');
    assert.equal(natives.length, 1, `${chain} should have one native asset`);
  }
});

test('BSC USDT carries 18 decimals, not the 6 used on Ethereum', () => {
  // The single most likely way to misprice an invoice by a factor of a trillion.
  const bsc = findCuratedAsset('bsc', '0x55d398326f99059fF775485246999027B3197955');
  const ethereum = findCuratedAsset('ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7');

  assert.equal(bsc?.decimals, 18);
  assert.equal(ethereum?.decimals, 6);
});

test('lookup is case-insensitive', () => {
  // A merchant pasting a lowercase address must still match.
  const canonical = '0x55d398326f99059fF775485246999027B3197955';
  assert.ok(findCuratedAsset('bsc', canonical.toLowerCase()));
  assert.ok(findCuratedAsset('bsc', canonical.toUpperCase().replace('0X', '0x')));
  assert.equal(isCurated('bsc', canonical.toLowerCase()), true);
});

test('an unknown contract is not curated', () => {
  assert.equal(isCurated('bsc', '0x9999999999999999999999999999999999999999'), false);
  assert.equal(findCuratedAsset('bsc', '0x9999999999999999999999999999999999999999'), null);
});

test('a native asset is found by passing no contract', () => {
  const native = findCuratedAsset('bsc', null);
  assert.equal(native?.symbol, 'BNB');
  assert.equal(native?.kind, 'native');
});

test('the same contract on a different chain does not match', () => {
  // Addresses are chain-scoped; treating them as global would credit the wrong asset.
  const bscUsdt = '0x55d398326f99059fF775485246999027B3197955';
  assert.ok(findCuratedAsset('bsc', bscUsdt));
  assert.equal(findCuratedAsset('polygon', bscUsdt), null);
});

test('symbolClaimedElsewhere catches a token borrowing a curated symbol', () => {
  // "USDT" on BSC is legitimate at one address and a fraud at every other.
  assert.equal(
    symbolClaimedElsewhere('bsc', '0x9999999999999999999999999999999999999999', 'USDT'),
    true,
  );
  assert.equal(
    symbolClaimedElsewhere('bsc', '0x55d398326f99059fF775485246999027B3197955', 'USDT'),
    false,
  );
  assert.equal(
    symbolClaimedElsewhere('bsc', '0x9999999999999999999999999999999999999999', 'MERCH'),
    false,
  );
});

test('every chain that is live has a stablecoin to accept', () => {
  // TON settles for free and BSC goes live first; both must have something to sell.
  for (const chain of ['bsc', 'ethereum', 'polygon', 'ton'] as const) {
    const stables = curatedForChain(chain).filter((asset) =>
      ['USDT', 'USDC'].includes(asset.symbol),
    );
    assert.ok(stables.length > 0, `${chain} has no curated stablecoin`);
  }
});

describe('catalogue coverage', () => {
  test('every chain carries its native asset', () => {
    /**
     * The one entry a chain cannot function without: the gas asset is what a merchant is
     * paid in when they accept a native payment, and a chain listed with no native entry is
     * a chain where the most obvious thing to try does not work.
     */
    for (const chain of SUPPORTED_CHAINS) {
      const native = CURATED_ASSETS.filter(
        (asset) => asset.chain === chain && asset.kind === 'native',
      );
      assert.equal(native.length, 1, `${chain} should carry exactly one native asset`);
    }
  });

  test('coverage finds the holes that are actually there', () => {
    /**
     * Pinned against controlled input rather than the whole chain list, because a coverage
     * function that returned nothing at all would satisfy every other test here — an empty
     * list of holes reads as "nothing missing".
     *
     * BSC carries both stablecoins, so it has no holes. TON carries USDT and not USDC, so it
     * has exactly one, and it must come back matched to *that* chain and symbol — a
     * declaration attached to the wrong hole is worse than none, because it silences the
     * warning without answering it.
     */
    assert.deepEqual(curatedCoverage(['bsc']), []);

    const ton = curatedCoverage(['ton']);
    assert.equal(ton.length, 1);
    assert.equal(ton[0]!.chain, 'ton');
    assert.equal(ton[0]!.symbol, 'USDC');
    assert.equal(ton[0]!.declared?.chain, 'ton');
    assert.equal(ton[0]!.declared?.symbol, 'USDC');
  });

  test('a declaration for one chain does not cover another', () => {
    /**
     * The failure mode that made this test necessary: matching a hole to the first gap in the
     * list rather than to its own. Solana carries both stablecoins, so if it ever stops, its
     * hole must not be silenced by TON's declaration.
     */
    for (const hole of curatedCoverage(SUPPORTED_CHAINS)) {
      if (hole.declared === null) continue;
      assert.equal(hole.declared.chain, hole.chain);
      assert.equal(hole.declared.symbol.toUpperCase(), hole.symbol.toUpperCase());
    }
  });

  test('every missing stablecoin is a declared gap, not an oversight', () => {
    /**
     * The test that turns an omission into a task. A chain quietly lacking USDC looks
     * exactly like a chain where we decided against it, and the only way to tell them apart
     * is for somebody to notice — usually a merchant asking why they cannot enable it.
     *
     * Adding the address is *not* something this test wants done quickly. A curated entry
     * arrives approved with no probe behind it, so a wrong address is a counterfeit
     * approved for every merchant at once. The gap is the safe state; declaring it is what
     * stops it being invisible.
     */
    const holes = curatedCoverage(SUPPORTED_CHAINS);
    assert.deepEqual(
      holes.filter((hole) => hole.declared === null).map((hole) => `${hole.symbol} on ${hole.chain}`),
      [],
      'declare it in CURATED_GAPS with why, or add the verified address',
    );
    // And every declared gap is reachable through coverage, so the two lists cannot drift
    // into one saying something the other does not.
    assert.equal(holes.length, CURATED_GAPS.length);
  });

  test('the declared gaps are the ones actually missing', () => {
    // The other direction. A gap left behind after its address was added would keep telling
    // an operator to go and do something already done.
    for (const gap of CURATED_GAPS) {
      const carried = CURATED_ASSETS.some(
        (asset) =>
          asset.chain === gap.chain && asset.symbol.toUpperCase() === gap.symbol.toUpperCase(),
      );
      assert.equal(carried, false, `${gap.symbol} on ${gap.chain} is carried; drop the gap`);
    }
  });

  test('a declared gap cites the issuer, with a page and a date', () => {
    /**
     * A reason of "not yet" is a note to nobody, and "verified by hand" is unfalsifiable a
     * year later. A URL and a date can be re-opened; a claim that somebody once looked
     * cannot.
     */
    for (const gap of CURATED_GAPS) {
      assert.ok(gap.reason.length > 60, `${gap.symbol} on ${gap.chain} needs a real reason`);
      assert.match(gap.source.url, /^https:\/\//);
      assert.match(gap.source.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('an absence the issuer created is not put in front of an operator as work', () => {
    /**
     * The distinction this whole model exists for, and the reason it is not cosmetic.
     *
     * USDC on TRON is the dangerous case: it *used to* exist, so an address is findable, the
     * contract is still on chain, and it would probe perfectly well. Telling an operator to
     * "add the missing USDC on TRON" is how somebody ends up adding a token whose issuer has
     * stopped minting and stopped redeeming it.
     */
    const work = openCuratedWork(SUPPORTED_CHAINS);
    assert.deepEqual(
      work.map((hole) => `${hole.symbol} on ${hole.chain}`),
      [],
      'every remaining hole is one the issuer never filled',
    );

    // And each is recorded as such rather than merely absent from the work list.
    const holes = curatedCoverage(SUPPORTED_CHAINS);
    assert.ok(holes.length > 0, 'USDC is genuinely not on every chain');
    assert.ok(holes.every((hole) => hole.declared?.kind === 'not_issued'));
  });

  test('an unverified gap is work, and an undeclared one is too', () => {
    /**
     * Both branches the real data cannot reach, which is why the gap list is injectable: with
     * production data every hole happens to be `not_issued`, and the failure mode here is
     * silent — a hole that stopped being reported would simply never be worked on.
     *
     * `unverified` means it exists and nobody has checked the address. Undeclared means
     * nobody decided at all. Both belong in front of an operator; only `not_issued` does not.
     */
    const unverified = openCuratedWork(['ton'], [
      {
        chain: 'ton',
        symbol: 'USDC',
        kind: 'unverified',
        reason: 'It exists and nobody has read the address off the issuer’s own page yet.',
        source: { url: 'https://example.test/', checkedOn: '2026-08-18' },
      },
    ]);
    assert.deepEqual(
      unverified.map((hole) => `${hole.symbol} on ${hole.chain}`),
      ['USDC on ton'],
    );

    // No declaration at all: an oversight is not an answer, so it must still surface.
    const undeclared = openCuratedWork(['ton'], []);
    assert.deepEqual(
      undeclared.map((hole) => `${hole.symbol} on ${hole.chain}`),
      ['USDC on ton'],
    );
    assert.equal(undeclared[0]!.reason, null, 'and it carries no reason, because there is none');

    // The closed kind is the only one filtered out.
    const closed = openCuratedWork(['ton'], [
      {
        chain: 'ton',
        symbol: 'USDC',
        kind: 'not_issued',
        reason: 'Circle does not issue USDC on TON, per their own multi-chain list.',
        source: { url: 'https://example.test/', checkedOn: '2026-08-18' },
      },
    ]);
    assert.deepEqual(closed, []);
  });

  test('every curated address names the page it was read from', () => {
    /**
     * The claim "verified against the issuer's own documentation" is worth nothing if the
     * page is not recorded: nobody can re-check it, and after a year nobody remembers whether
     * anybody checked at all.
     *
     * A block explorer is explicitly not an acceptable source. Its search ranks by activity,
     * and a well-funded copycat outranks the real contract.
     */
    for (const asset of CURATED_ASSETS) {
      assert.match(asset.source.url, /^https:\/\//, `${asset.symbol} on ${asset.chain}`);
      assert.match(asset.source.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
      for (const explorer of ['etherscan', 'bscscan', 'polygonscan', 'tronscan', 'solscan', 'tonviewer']) {
        assert.ok(
          !asset.source.url.includes(explorer),
          `${asset.symbol} on ${asset.chain} cites ${explorer}; explorers rank by activity`,
        );
      }
    }
  });

  test('a token somebody other than the issuer stands behind says so', () => {
    /**
     * Three of our entries are bridged, and none of them is a Tether or Circle liability:
     * Binance-Peg BSC-USD and USDC on BNB Chain, and bridged USDT on Polygon. Both issuers
     * omit those chains from their own supported lists, which is how we know.
     *
     * They are perfectly usable and merchants accept them. But they fail differently — a
     * bridged token depends on its custodian as well as on the issuer's reserves — and a
     * merchant choosing what to accept is entitled to know which they are taking.
     */
    const bridged = bridgedAssets().map((asset) => `${asset.symbol} on ${asset.chain}`);
    assert.deepEqual(bridged.sort(), ['USDC on bsc', 'USDT on bsc', 'USDT on polygon']);

    for (const asset of bridgedAssets()) {
      // The note has to say it in words too: the flag drives a badge, the note is what an
      // operator reads when they ask why.
      assert.match(asset.note, /Binance-Peg|Bridged|bridged/);
    }
  });

  test('a native stablecoin is one its own issuer mints there', () => {
    // The converse, so the flag cannot quietly become decorative: anything marked native and
    // carrying a contract must cite the issuer's own page, not a chain's.
    for (const asset of CURATED_ASSETS) {
      if (asset.issuer !== 'native' || asset.kind === 'native') continue;
      assert.ok(
        asset.source.url.includes('tether.to') || asset.source.url.includes('circle.com'),
        `${asset.symbol} on ${asset.chain} claims native issuance but cites ${asset.source.url}`,
      );
    }
  });

  test('the expected set is the two stablecoins merchants ask for', () => {
    // Stated so that widening it is a deliberate act with a test behind it, rather than
    // something that happens by editing a list nobody is watching.
    assert.deepEqual([...EXPECTED_STABLECOINS], ['USDT', 'USDC']);
  });
});

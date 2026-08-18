import {
  CURATED_ASSETS,
  ContractProbe,
  SUPPORTED_CHAINS,
  assessRisk,
  curatedCoverage,
  findCuratedAsset,
  isCurated,
  rateFromDecimalString,
  type ChainId,
  type VettingReport,
} from '@avex/core';
import { and, count, eq } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { assets, merchantAssets } from '../db/schema.js';
import type { AuditService } from './audit.js';
import type { StaffRole } from './staff-rbac.js';

/**
 * The asset catalogue: what exists, what has been vetted, and what each merchant
 * has switched on.
 *
 * Approval and enablement are kept apart on purpose. AVEX decides whether a
 * contract may credit invoices at all; a merchant decides whether they want it.
 * Collapsing the two would let a merchant's preference imply a safety judgement.
 */

export class AssetConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssetConfigError';
  }
}

export interface ConfigureAssetInput {
  readonly organizationId: string;
  readonly assetId: string;
  readonly enabled: boolean;
  readonly pricingMode: 'fiat' | 'token' | 'fixed_rate';
  /** Decimal string, e.g. "0.25". Required when the mode is `fixed_rate`. */
  readonly fixedRate?: string;
  readonly fixedRateValidUntil?: Date;
  readonly spreadBps?: number;
  readonly toleranceBps?: number;
}

export class AssetService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly probe: ContractProbe,
    /** Symbols the configured price sources can quote. */
    private readonly pricedSymbols: readonly string[],
  ) {}

  /**
   * Insert the curated list, skipping anything already present.
   *
   * Idempotent so it can run on every deploy. Curated entries are the only ones
   * that arrive already `approved`, because each address was verified by hand
   * against the issuer's documentation.
   */
  async seedCurated(): Promise<number> {
    let inserted = 0;

    for (const asset of CURATED_ASSETS) {
      const existing = await this.findAsset(asset.chain, asset.contract ?? null);
      if (existing) continue;

      await this.db.insert(assets).values({
        chain: asset.chain,
        symbol: asset.symbol,
        contract: asset.contract ?? null,
        decimals: asset.decimals,
        kind: asset.kind,
        curated: true,
        verdict: 'approved',
        requiresFixedRate: !this.pricedSymbols.includes(asset.symbol.toUpperCase()),
        reviewNote: asset.note,
      });
      inserted += 1;
    }

    return inserted;
  }

  private async findAsset(chain: ChainId, contract: string | null) {
    const rows = await this.db
      .select()
      .from(assets)
      .where(
        contract === null
          ? and(eq(assets.chain, chain), eq(assets.contract, ''))
          : and(eq(assets.chain, chain), eq(assets.contract, contract)),
      )
      .limit(1);

    if (rows.length > 0) return rows[0];

    // A native asset stores NULL, which `eq` cannot match.
    if (contract === null) {
      const natives = await this.db.select().from(assets).where(eq(assets.chain, chain));
      return natives.find((row) => row.contract === null);
    }
    // Addresses are case-insensitive; a merchant pasting lowercase must still match.
    const all = await this.db.select().from(assets).where(eq(assets.chain, chain));
    return all.find((row) => row.contract?.toLowerCase() === contract.toLowerCase());
  }

  /**
   * Vet a merchant-submitted contract and record the outcome.
   *
   * The verdict is never `approved` for a submission: a clean probe earns `review`,
   * and a human decides. Accumulating passed checks into permission is exactly how
   * an unvetted contract ends up crediting real invoices.
   */
  async submitContract(
    organizationId: string,
    chain: ChainId,
    contract: string,
    actor: { userId: string; ip?: string | null },
  ): Promise<{ assetId: string; report: VettingReport }> {
    const already = await this.findAsset(chain, contract);
    if (already) {
      throw new AssetConfigError(
        'asset_exists',
        'This contract is already in the catalogue.',
      );
    }

    const report = await this.probe.probe({
      chain,
      contract,
      curated: isCurated(chain, contract),
      pricedSymbols: this.pricedSymbols,
    });

    const assessment = assessRisk(report.findings, {
      ...(isCurated(chain, contract) ? { curated: true } : {}),
    });

    if (report.metadata.decimals === null) {
      throw new AssetConfigError(
        'not_a_token',
        'This address does not behave like a token contract. ' +
          assessment.reasons.join('; '),
      );
    }

    const [created] = await this.db
      .insert(assets)
      .values({
        chain,
        symbol: report.metadata.symbol ?? 'UNKNOWN',
        contract,
        decimals: report.metadata.decimals,
        kind: chain === 'tron' ? 'trc20' : 'erc20',
        curated: false,
        verdict: report.verdict,
        requiresFixedRate: report.requiresFixedRate,
        findings: report.findings as unknown[],
        probedAt: new Date(report.probedAt),
        submittedByOrganizationId: organizationId,
      })
      .returning({ id: assets.id });

    await this.audit.record({
      organizationId,
      userId: actor.userId,
      ip: actor.ip ?? null,
      action: 'asset.submitted',
      targetType: 'asset',
      targetId: created!.id,
      metadata: {
        chain,
        contract,
        symbol: report.metadata.symbol,
        verdict: report.verdict,
        reasons: assessment.reasons,
        unknowns: assessment.unknowns,
      },
    });

    return { assetId: created!.id, report };
  }

  /**
   * Turn an asset on for a merchant and record how it should be priced.
   *
   * Every rule here exists because breaking it produces silently wrong invoices
   * rather than a visible error.
   */
  async configure(
    input: ConfigureAssetInput,
    actor: { userId: string; ip?: string | null },
  ): Promise<void> {
    const [asset] = await this.db
      .select()
      .from(assets)
      .where(eq(assets.id, input.assetId))
      .limit(1);
    if (!asset) throw new AssetConfigError('not_found', 'No such asset.');

    // Only AVEX can approve; a merchant enabling an unapproved contract would
    // bypass review entirely.
    if (input.enabled && asset.verdict !== 'approved') {
      throw new AssetConfigError(
        'not_approved',
        asset.verdict === 'blocked'
          ? 'This contract failed vetting and cannot be enabled.'
          : 'This contract is still under review. You will be notified when it is decided.',
      );
    }

    // An asset submitted by another merchant is not visible to this one.
    if (
      asset.submittedByOrganizationId !== null &&
      asset.submittedByOrganizationId !== input.organizationId
    ) {
      throw new AssetConfigError('not_found', 'No such asset.');
    }

    let fixedRateScaled: string | null = null;
    let fixedRateValidUntil: Date | null = null;

    if (input.pricingMode === 'fixed_rate') {
      if (!input.fixedRate) {
        throw new AssetConfigError('rate_required', 'A fixed rate needs a rate.');
      }
      if (!input.fixedRateValidUntil) {
        // A rate with no expiry is a rate nobody revisits, and a stale one
        // misprices every invoice without ever failing.
        throw new AssetConfigError(
          'expiry_required',
          'A fixed rate needs an expiry date, so it cannot go stale unnoticed.',
        );
      }
      if (input.fixedRateValidUntil.getTime() <= Date.now()) {
        throw new AssetConfigError('expiry_in_past', 'The expiry date must be in the future.');
      }

      // Parsed through the integer path, so a malformed rate fails here rather
      // than becoming a wrong amount later.
      fixedRateScaled = rateFromDecimalString(input.fixedRate, Date.now()).priceScaled.toString();
      fixedRateValidUntil = input.fixedRateValidUntil;
    } else if (asset.requiresFixedRate) {
      // The link back to the pricing engine: no source can quote this symbol, so a
      // market-rate mode would have nothing to convert with.
      throw new AssetConfigError(
        'fixed_rate_required',
        `No price source can quote ${asset.symbol}, so it must be priced with a fixed rate.`,
      );
    }

    const values = {
      organizationId: input.organizationId,
      assetId: input.assetId,
      enabled: input.enabled,
      pricingMode: input.pricingMode,
      fixedRateScaled,
      fixedRateValidUntil,
      spreadBps: input.spreadBps ?? 50,
      toleranceBps: input.toleranceBps ?? 50,
      updatedAt: new Date(),
    };

    await this.db
      .insert(merchantAssets)
      .values(values)
      .onConflictDoUpdate({
        target: [merchantAssets.organizationId, merchantAssets.assetId],
        set: values,
      });

    await this.audit.record({
      organizationId: input.organizationId,
      userId: actor.userId,
      ip: actor.ip ?? null,
      action: input.enabled ? 'asset.enabled' : 'asset.disabled',
      targetType: 'asset',
      targetId: input.assetId,
      metadata: {
        symbol: asset.symbol,
        chain: asset.chain,
        pricingMode: input.pricingMode,
        fixedRate: input.fixedRate ?? null,
        toleranceBps: values.toleranceBps,
      },
    });
  }

  /** Assets this merchant may see: the curated catalogue plus their own submissions. */
  async listForMerchant(organizationId: string) {
    const catalogue = await this.db.select().from(assets);
    const configured = await this.db
      .select()
      .from(merchantAssets)
      .where(eq(merchantAssets.organizationId, organizationId));

    const byAssetId = new Map(configured.map((row) => [row.assetId, row]));

    return catalogue
      .filter(
        (asset) =>
          asset.submittedByOrganizationId === null ||
          asset.submittedByOrganizationId === organizationId,
      )
      .map((asset) => {
        const config = byAssetId.get(asset.id);
        return {
          id: asset.id,
          chain: asset.chain,
          symbol: asset.symbol,
          contract: asset.contract,
          decimals: asset.decimals,
          kind: asset.kind,
          curated: asset.curated,
          verdict: asset.verdict,
          /**
           * Shown rather than filtered out, and that is the point.
           *
           * An asset that vanished from a merchant's list the day we stopped offering it
           * would leave them with invoices refused and nothing on the page explaining why.
           * Returned with its state instead, so the answer is where they are already
           * looking.
           */
          listed: asset.listed,
          requiresFixedRate: asset.requiresFixedRate,
          findings: asset.findings ?? [],
          enabled: config?.enabled ?? false,
          pricingMode: config?.pricingMode ?? null,
          fixedRateValidUntil: config?.fixedRateValidUntil?.toISOString() ?? null,
          spreadBps: config?.spreadBps ?? null,
          toleranceBps: config?.toleranceBps ?? null,
        };
      });
  }

  // ── the platform catalogue, as staff see it ────────────────────────────────

  /**
   * Every asset the platform knows, with how many merchants are actually using it.
   *
   * The usage count is what makes this a decision rather than a list: unlisting an asset
   * fourteen merchants have enabled is a very different act from unlisting one nobody has
   * touched, and an operator about to do it should not have to go and find out.
   */
  async catalogue(): Promise<
    readonly {
      readonly id: string;
      readonly chain: string;
      readonly symbol: string;
      readonly contract: string | null;
      readonly decimals: number;
      readonly kind: string;
      readonly curated: boolean;
      readonly verdict: string;
      readonly listed: boolean;
      readonly requiresFixedRate: boolean;
      readonly priced: boolean;
      readonly note: string | null;
      readonly submittedByOrganizationId: string | null;
      readonly enabledByMerchants: number;
      readonly createdAt: string;
    }[]
  > {
    const rows = await this.db.select().from(assets).orderBy(assets.chain, assets.symbol);

    const usage = await this.db
      .select({ assetId: merchantAssets.assetId, value: count() })
      .from(merchantAssets)
      .where(eq(merchantAssets.enabled, true))
      .groupBy(merchantAssets.assetId);
    const byAsset = new Map(usage.map((row) => [row.assetId, row.value]));

    return rows.map((asset) => ({
      id: asset.id,
      chain: asset.chain,
      symbol: asset.symbol,
      contract: asset.contract,
      decimals: asset.decimals,
      kind: asset.kind,
      curated: asset.curated,
      verdict: asset.verdict,
      listed: asset.listed,
      requiresFixedRate: asset.requiresFixedRate,
      /**
       * Whether any configured price source can quote it.
       *
       * Shown beside the listing switch because the two interact: listing an asset nothing
       * can price means every merchant who enables it must set their own rate, which is a
       * decision worth making knowingly rather than discovering.
       */
      priced: this.pricedSymbols.includes(asset.symbol),
      note: findCuratedAsset(asset.chain as ChainId, asset.contract)?.note ?? null,
      submittedByOrganizationId: asset.submittedByOrganizationId,
      enabledByMerchants: byAsset.get(asset.id) ?? 0,
      createdAt: asset.createdAt.toISOString(),
    }));
  }

  /**
   * Stablecoins a chain we support does not carry, with why not.
   *
   * Surfaced beside the catalogue so an omission is a visible task rather than something a
   * merchant discovers. Each one names where the address must be read from, because a
   * curated entry arrives approved with no probe behind it — a wrong address is a
   * counterfeit approved for every merchant at once, and the commonest way a wrong one gets
   * in is somebody typing an address they half-remember.
   */
  gaps(): readonly {
    readonly chain: string;
    readonly symbol: string;
    readonly reason: string | null;
  }[] {
    return curatedCoverage(SUPPORTED_CHAINS).map((hole) => ({
      chain: hole.chain,
      symbol: hole.symbol,
      reason: hole.declared?.reason ?? null,
    }));
  }

  /**
   * Open or close an asset for the whole platform.
   *
   * Separate from a verdict on purpose. `verdict` says whether the contract is what it
   * claims to be; this says whether we are taking it today. Solana's USDC mint is a good
   * contract whether or not our Solana watcher is running, and recording "blocked" for an
   * operational pause would put a judgement about Circle in our own audit trail.
   *
   * Unlisting stops new invoices and nothing else. Invoices already open keep working:
   * their deposit addresses are committed and a payer may be mid-transfer, so pulling the
   * asset out from under them would strand real money.
   */
  async setListing(
    actor: { readonly staffId: string; readonly role: StaffRole },
    assetId: string,
    listed: boolean,
    note: string,
  ): Promise<{ readonly symbol: string; readonly chain: string; readonly affected: number }> {
    const [asset] = await this.db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!asset) throw new AssetConfigError('not_found', 'No such asset.');

    const [usage] = await this.db
      .select({ value: count() })
      .from(merchantAssets)
      .where(and(eq(merchantAssets.assetId, assetId), eq(merchantAssets.enabled, true)));
    const affected = usage?.value ?? 0;

    await this.db.update(assets).set({ listed }).where(eq(assets.id, assetId));

    await this.audit.record({
      staffId: actor.staffId,
      action: listed ? 'asset.listed' : 'asset.unlisted',
      targetType: 'asset',
      targetId: assetId,
      metadata: {
        chain: asset.chain,
        symbol: asset.symbol,
        contract: asset.contract,
        note,
        role: actor.role,
        /**
         * Recorded because it is the size of the act.
         *
         * "Unlisted USDT on TRON" and "unlisted USDT on TRON, which 41 merchants were
         * accepting" are different events, and only one of them explains the support
         * queue the following morning.
         */
        enabledByMerchants: affected,
      },
    });

    return { symbol: asset.symbol, chain: asset.chain, affected };
  }

  /**
   * Add an asset to the platform catalogue by hand, already approved.
   *
   * The path for a token we have verified ourselves rather than one a merchant submitted.
   * It bypasses the probe, which is exactly why it is superadmin-only and elevation-gated:
   * approving a counterfeit here approves it for every merchant at once, and the whole
   * defence against a token calling itself USDT is knowing which address the real one
   * lives at.
   *
   * `curated` stays false. That flag means "on the list compiled in code and verified
   * against the issuer's documentation", and marking a hand-added row as curated would
   * make the codebase's own list look longer than it is.
   */
  async addToCatalogue(
    actor: { readonly staffId: string; readonly role: StaffRole },
    input: {
      readonly chain: ChainId;
      readonly symbol: string;
      readonly contract: string | null;
      readonly decimals: number;
      readonly kind: 'native' | 'erc20' | 'trc20' | 'spl' | 'jetton';
      readonly note: string;
      readonly listed?: boolean;
    },
  ): Promise<{ readonly assetId: string }> {
    const existing = await this.findAsset(input.chain, input.contract);
    if (existing) {
      throw new AssetConfigError(
        'already_exists',
        `${existing.symbol} on ${existing.chain} is already in the catalogue.`,
      );
    }

    const requiresFixedRate = !this.pricedSymbols.includes(input.symbol);

    const [created] = await this.db
      .insert(assets)
      .values({
        chain: input.chain,
        symbol: input.symbol,
        contract: input.contract,
        decimals: input.decimals,
        kind: input.kind,
        // Not curated: that flag means "in the list compiled in code".
        curated: false,
        verdict: 'approved',
        listed: input.listed ?? true,
        requiresFixedRate,
        reviewedByStaffId: actor.staffId,
        reviewedAt: new Date(),
        reviewNote: input.note,
      })
      .returning({ id: assets.id });

    await this.audit.record({
      staffId: actor.staffId,
      action: 'asset.added',
      targetType: 'asset',
      targetId: created!.id,
      metadata: {
        chain: input.chain,
        symbol: input.symbol,
        contract: input.contract,
        decimals: input.decimals,
        kind: input.kind,
        note: input.note,
        requiresFixedRate,
        role: actor.role,
      },
    });

    return { assetId: created!.id };
  }

  /** Curated entry backing an asset row, for display. */
  curatedNote(chain: ChainId, contract: string | null): string | null {
    return findCuratedAsset(chain, contract)?.note ?? null;
  }
}

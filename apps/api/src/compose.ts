import {
  chainConfig,
  ContractProbe,
  createPriceSources,
  DEFAULT_BREAKER,
  DEFAULT_DISPATCHER,
  FetchPoster,
  PriceService,
  SUPPORTED_CHAINS,
  WebhookDispatcher,
} from '@avex/core';
import type { PriceSymbol } from '@avex/core';
import type { FastifyInstance } from 'fastify';

import type { Database } from './db/client.js';
import { AdminService } from './domain/admin-service.js';
import { AssetService } from './domain/asset-service.js';
import { AuditService } from './domain/audit.js';
import { AuthService } from './domain/auth-service.js';
import { CheckoutService } from './domain/checkout-service.js';
import { DepositAddressDeriver } from './domain/deposit-address.js';
import { CommissionLedger } from './domain/commission-ledger.js';
import { delayFor } from './domain/rbac.js';
import { WalletPoolChanges, WalletPoolService } from './domain/wallet-pool-service.js';
import { paymentValueSource, paymentValueUsd } from './domain/payment-valuation.js';
import { FeePlanService } from './domain/fee-plan-service.js';
import { InviteService } from './domain/invite-service.js';
import { InvoiceCreationService } from './domain/invoice-creation.js';
import { MembershipService } from './domain/membership-service.js';
import { MerchantService } from './domain/merchant-service.js';
import { DatabasePaymentSink } from './domain/payment-sink.js';
import { PayoutAddressService } from './domain/payout-service.js';
import type { TickRow } from './domain/price-repository.js';
import { ReconciliationService } from './domain/reconciliation-service.js';
import { SettlementStore } from './domain/settlement-store.js';
import { StaffAuthService } from './domain/staff-auth.js';
import { WebhookService } from './domain/webhook-service.js';
import type { Env } from './env.js';
import { ConsoleMailer } from './mailer.js';
import { JsonRpcCaller } from './rpc/json-rpc-caller.js';
import { buildServer } from './http/server.js';
import type { AppContext } from './http/server.js';

/**
 * Everything the API is made of, in one place.
 *
 * Extracted from `main.ts` because there are now two ways to run this: a process that
 * listens on a port, and a serverless isolate that is handed one request at a time. Both
 * need the identical graph of services, and two copies of a twenty-service wiring would
 * drift — the second one would be missing whatever was added last, and the symptom would be
 * a route that works locally and 500s in the deployment that matters.
 *
 * What is *not* here is anything that assumes a process: the settlement signers, the job
 * timers, the tick writer's flush loop, signal handlers. Those stay in `main.ts`, which is
 * the file that knows it has a process to put them in.
 */

export interface ComposeOptions {
  readonly env: Env;
  readonly db: Database;
  /**
   * Where to send price observations, if anywhere.
   *
   * Optional because the buffered writer flushes on a timer, and a timer in an isolate that
   * gets frozen between requests either never fires or fires against a closed pool. A
   * deployment without a process simply does not record ticks — they are diagnostics, not
   * money.
   */
  readonly recordTick?: ((tick: TickRow) => void) | undefined;
  /** Where warnings from services that predate the logger go. Defaults to the console. */
  readonly warn?: ((message: string) => void) | undefined;
}

export interface Composed {
  readonly app: FastifyInstance;
  readonly context: AppContext;
  /** Exposed because `main.ts` seeds the catalogue at boot and an isolate must not. */
  readonly assets: AssetService;
}

export function compose(options: ComposeOptions): Composed {
  const { env, db } = options;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const audit = new AuditService(db);
  const auth = new AuthService(db, audit, {
    sessionTtlMs: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
    emailTokenTtlMs: env.EMAIL_TOKEN_TTL_MINUTES * 60 * 1000,
  });

  const prices = new PriceService(
    createPriceSources(env.PRICE_SOURCES),
    {
      aggregation: {
        minSources: env.PRICE_MIN_SOURCES,
        outlierToleranceBps: env.PRICE_OUTLIER_TOLERANCE_BPS,
        maxDispersionBps: env.PRICE_MAX_DISPERSION_BPS,
        maxStalenessMs: env.PRICE_MAX_STALENESS_MS,
      },
      breaker: DEFAULT_BREAKER,
      cacheTtlMs: env.PRICE_CACHE_TTL_MS,
    },
    options.recordTick,
  );

  const assets = new AssetService(
    db,
    audit,
    new ContractProbe(new JsonRpcCaller(env.EVM_RPC_URLS)),
    [...prices.coverage().keys()],
  );

  const mailer = new ConsoleMailer(env.APP_URL);
  const payouts = new PayoutAddressService(db, audit, mailer);
  const invites = new InviteService(db, audit);
  const memberships = new MembershipService(db, audit, mailer);

  const webhooks = new WebhookService(
    db,
    new WebhookDispatcher(new FetchPoster(DEFAULT_DISPATCHER.timeoutMs)),
    warn,
  );

  // Credits transfers the watcher finds, and queues the callbacks that tell a merchant
  // about them. Enqueueing is a database write, so a slow merchant endpoint can never
  // delay crediting a payment.
  /**
   * What merchants owe us for payments no chain took a cut of.
   *
   * Constructed before the sink and the fee plans because both need it: the sink writes the
   * accrual when a pooled payment is credited, and the fee plans read the balance to size the
   * recovery onto a later invoice on a chain that can take one.
   */
  const ledger = new CommissionLedger(db);

  const paymentSink = new DatabasePaymentSink(
    db,
    audit,
    webhooks,
    paymentValueUsd(prices),
    paymentValueSource(),
    ledger,
  );

  const feePlans = new FeePlanService(db, audit, {
    feeCollectors: env.FEE_COLLECTORS,
    ledger,
  });

  /**
   * Address derivation, built from configuration alone.
   *
   * Every EVM chain shares one creation code because they run identical bytecode; the
   * factory address differs because each chain has its own deployment. A chain absent from
   * `FORWARDER_FACTORIES` simply cannot issue invoices, which is the safe direction — a
   * defaulted factory would hand payers addresses no CREATE2 produces.
   */
  const deriver = new DepositAddressDeriver(
    {
      evm: Object.fromEntries(
        Object.entries(env.FORWARDER_FACTORIES).map(([chain, factory]) => [
          chain,
          { factory, forwarderCreationCode: env.FORWARDER_CREATION_CODE },
        ]),
      ),
      shared: env.SHARED_DEPOSIT_WALLETS,
      /**
       * Read from the chain registry rather than from configuration, because it is not a
       * deployment choice. A chain is pooled because of how its transfers work — TRC-20 carries
       * no memo and a per-invoice contract pays for its own code — and no environment variable
       * changes that.
       */
      pooled: SUPPORTED_CHAINS.filter((chain) => chainConfig(chain).addressModel === 'pooled'),
    },
    env.MEMO_SECRET,
  );

  /** The merchant's own deposit wallets, for the chains whose addresses are not derivable. */
  const walletPool = new WalletPoolService(db);
  /**
   * Adding a wallet, on the payout address's delay and using its own notice.
   *
   * The delay comes from the RBAC table rather than a constant here, so the two protections
   * cannot drift: `payout_address:write` is what both routes require.
   */
  const walletChanges = new WalletPoolChanges(
    db,
    walletPool,
    audit,
    mailer,
    delayFor('payout_address:write') ?? 24 * 60 * 60 * 1000,
  );

  // The pricing engine, narrowed to the one method invoice creation needs.
  const rates = { requireRate: (symbol: PriceSymbol) => prices.requireRate(symbol) };
  const invoiceCreation = new InvoiceCreationService(
    db,
    deriver,
    feePlans,
    rates,
    audit,
    ledger,
    walletPool,
  );

  const settlements = new SettlementStore(db);
  const reconciliation = new ReconciliationService(db, audit, paymentSink);

  const context: AppContext = {
    env,
    db,
    auth,
    audit,
    prices,
    assets,
    payouts,
    invites,
    memberships,
    staffAuth: new StaffAuthService(db, audit),
    admin: new AdminService(db, audit, settlements, reconciliation),
    settlements,
    reconciliation,
    merchant: new MerchantService(db),
    invoiceCreation,
    checkouts: new CheckoutService(db, invoiceCreation, feePlans, deriver, rates, audit, ledger),
    webhooks,
    feePlans,
    ledger,
    walletPool,
    walletChanges,
    minPriceSources: env.PRICE_MIN_SOURCES,
    // A real transport still to come; the seam is what matters now.
    mailer,
  };

  return { app: buildServer(context), context, assets };
}

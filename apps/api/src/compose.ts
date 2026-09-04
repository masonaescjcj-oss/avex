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
import { depositAddressConfig } from './domain/deposit-address-config.js';
import { DepositAddressDeriver } from './domain/deposit-address.js';
import { CommissionLedger } from './domain/commission-ledger.js';
import { delayFor } from './domain/rbac.js';
import { WalletPoolChanges, WalletPoolService } from './domain/wallet-pool-service.js';
import { paymentValueSource, paymentValueUsd } from './domain/payment-valuation.js';
import { FeePlanService } from './domain/fee-plan-service.js';
import { ChainMinimums } from './domain/chain-minimums.js';
import { feePolicy } from './fee-policy.js';
import { RpcGasOracle } from './domain/gas-oracle.js';
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
import { ConsoleMailer, SmtpMailer } from './mailer.js';
import { parseSmtpUrl } from './mail/smtp.js';
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
  const auth = new AuthService(
    db,
    audit,
    {
      sessionTtlMs: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
      emailTokenTtlMs: env.EMAIL_TOKEN_TTL_MINUTES * 60 * 1000,
    },
    /**
     * What a new organisation needs before it is usable: a fee plan.
     *
     * Without one a merchant cannot be quoted a rate, so cannot be given a deposit address, so
     * cannot take a payment — and nothing created one, so that was every merchant who ever
     * signed up. `ensureForOrganization` was called from thirty-four places and all of them
     * were tests.
     *
     * A closure rather than a direct reference because `feePlans` is constructed further down.
     * That is safe for the reason that matters: this runs when somebody signs up, long after
     * `compose` has returned, so the binding is initialised by the time it is read. Moving the
     * two lines together would work as well and would reorder a graph that has its own reasons.
     */
    (tx, organizationId) => feePlans.ensureForOrganization(organizationId, new Date(), tx).then(),
  );

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

  /**
   * The real transport when one is configured, and a loud console when not.
   *
   * Announced either way. A deployment silently logging its verification mails to stdout looks
   * exactly like a working one until the first merchant tries to confirm an address — and the
   * twenty-four-hour delay on a payout address change protects nobody if the notice about it
   * went to a log file.
   */
  const mailer =
    env.SMTP_URL === undefined
      ? (warn(
          'SMTP_URL is not set: transactional mail is logged, not sent. Email verification, ' +
            'invitations and payout-change notices will not reach anyone.',
        ),
        new ConsoleMailer(env.APP_URL, warn))
      : new SmtpMailer(
          env.APP_URL,
          parseSmtpUrl(env.SMTP_URL),
          env.MAIL_FROM,
          env.MAIL_FROM_NAME,
          warn,
        );
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

  /**
   * Live gas, so the payer pays for the transfer rather than us.
   *
   * Built from the same endpoint pool the contract probe uses and the same price service the
   * quotes come from — a second source for either would eventually disagree with the first, and
   * this figure ends up inside a deposit address that can never be re-derived.
   */
  const gas = new RpcGasOracle(new JsonRpcCaller(env.EVM_RPC_URLS), prices, warn);

  /**
   * The floor under an invoice, from the same snapshot the fee is priced from.
   *
   * One oracle for both, so the figure that decides whether an order is worth taking is the
   * figure it is charged against. Two probes could disagree by a block and produce an invoice
   * that was accepted at one gas price and priced at another.
   */
  /**
   * One policy for the whole process, from the environment.
   *
   * The minimum an invoice must clear and the commission it carries come out of the same
   * numbers, so they cannot be allowed to come from two objects: a deployment that lowered
   * its floor and left the commission service on the compiled-in default would accept an
   * order at one policy and price it at another.
   */
  const policy = feePolicy(env);
  const minimums = new ChainMinimums(gas, policy);

  const feePlans = new FeePlanService(db, audit, {
    feeCollectors: env.FEE_COLLECTORS,
    ledger,
    gas,
    warn,
    feePolicy: policy,
  });

  /**
   * Address derivation, built from configuration alone.
   *
   * The rule for which chains this offers is in `depositAddressConfig`, next to the deriver and
   * beside the test that holds it to the watcher's rule. It is not inline here because the two
   * sides disagreeing is a way to take money and never report it.
   */
  const deriver = new DepositAddressDeriver(depositAddressConfig(env), env.MEMO_SECRET);

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
    minimums,
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
    checkouts: new CheckoutService(
      db,
      invoiceCreation,
      feePlans,
      deriver,
      rates,
      audit,
      ledger,
      minimums,
    ),
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

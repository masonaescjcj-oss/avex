import type { Asset, ChainId, GasSnapshot, IncomingPayment } from '../../types.js';
import { noSettlementNeeded } from '../ChainAdapter.js';
import type {
  ChainAdapter,
  DeriveInput,
  DepositTarget,
  PollCursor,
  PollResult,
  SettlementRequest,
} from '../ChainAdapter.js';
import { isSolanaAddress } from './address.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAccount,
} from './ata.js';
import type { SolanaRpc } from './SolanaRpc.js';

/**
 * Solana, for detecting payments into the merchant's own wallets.
 *
 * The stub this replaces was written for a different design: a unique deposit account per
 * invoice, derived, swept by us. That design needs an ed25519 keypair per invoice, a
 * settlement path that closes associated token accounts to reclaim their rent, and a signer
 * this repository does not have. It was never built, so `watchableChains` excluded the chain
 * and the checkout never offered it — safe, and also permanently unavailable.
 *
 * The design here is the one TRON already uses and the one this product is actually built
 * on: the payer sends to a wallet the merchant owns, and the exact amount says which invoice
 * it was for. Nothing is derived, nothing is swept, no key is held. What is left is watching,
 * which is what this class does.
 *
 * ## Why watching Solana is not watching an EVM chain
 *
 * There is no `eth_getLogs`. An SPL transfer emits no event a filter can match; it moves a
 * balance between two token accounts, and the only record is the transaction itself. So the
 * question has to be asked from the other end — not "what happened in these slots" but "what
 * happened to these accounts" — and that is three steps rather than one:
 *
 * 1. **Which accounts.** A payer sending USDT to a merchant does not send it to the
 *    merchant's address. They send it to the *associated token account* for that mint owned
 *    by that address, which is a different public key entirely. That address is derived
 *    here, offline, in `ata.ts` — not asked for. Asking (`getTokenAccountsByOwner`) was the
 *    first version and was wrong twice over: the answer for a wallet that has never held the
 *    token is "no account", so there would be nothing to watch until the first payment, which
 *    is the payment that would be missed; and publicnode's free endpoint refuses the method
 *    with HTTP 403, which took the whole poll with it. Derived, the address is known before
 *    the account exists, and the transaction that creates and credits it is seen.
 *
 *    The method is still called once per wallet and mint, if the endpoint serves it, to pick
 *    up a token account that is *not* the associated one — some wallets and most exchanges
 *    hold balances in accounts they created directly. A payer paying a merchant sends to the
 *    associated account, because that is what a wallet computes from an address, so this is
 *    breadth rather than the load-bearing path, and a refusal is a warning rather than a
 *    failed poll.
 *
 * 2. **Which transactions.** `getSignaturesForAddress` on each of those accounts, newest
 *    first, paged back until it reaches the cursor. Native SOL is the one case where the
 *    wallet address itself is the account to ask about, because lamports move to the wallet
 *    and not to a token account.
 *
 * 3. **What moved.** `getTransaction`, and then the balances before and after rather than
 *    the instructions. A transfer can be a plain `transfer`, a `transferChecked`, or an
 *    instruction inside a program nobody here has heard of; all three change
 *    `postTokenBalances`, and only the first two are recognisable as instructions. Reading
 *    the delta is what makes an exchange withdrawal, a wallet send and a CPI from some
 *    aggregator all count the same.
 *
 * ## What is deliberately not credited
 *
 * A transaction the receiving wallet signed itself. A merchant swapping SOL for USDT in
 * their own wallet increases their own token balance, and crediting that as a customer's
 * payment would invent revenue and — on a pooled chain, where the sole open invoice takes
 * whatever arrives — attach it to somebody's order. If the wallet signed, it is not a
 * payment to the wallet.
 *
 * ## The one precision limit worth stating
 *
 * Lamport balances arrive as JSON numbers, so a wallet holding more than about nine million
 * SOL loses precision in the *delta* of a native payment. Token amounts do not have this
 * problem — the RPC sends them as strings, which is why `uiTokenAmount.amount` is read and
 * `uiAmount` is not.
 */

/** Where a transfer's recipient is looked up, to decide whether it is ours. */
export interface SolanaAddressBook {
  lookup(address: string): Promise<string | null>;
  /** Every wallet on this chain a transfer to which would be ours, as stored. */
  watched(): Promise<readonly string[]>;
}

/** Native price, for the gas model. Never consulted during a poll. */
export interface SolanaPriceOracle {
  nativePriceUsd(): Promise<number>;
}

export interface SolanaAdapterConfig {
  /**
   * SPL mints we watch, with the merchant-facing assets they belong to. Anything not in here
   * is ignored: a mint calling itself USDC costs almost nothing to create, and
   * auto-crediting an unknown one would make one of them revenue.
   */
  readonly acceptedAssets: readonly Asset[];
  /**
   * Slots held back from the finalized head before a range is scanned.
   *
   * Solana's `finalized` commitment is already irreversible, so this is not about safety —
   * it is about the number the sink is shown. A transfer is presented once, with the
   * confirmations it has at that moment, and the sink asks for the chain's standard count
   * before it will credit. Staying this far behind means the ordinary payment satisfies that
   * on first sight instead of being deferred and shown again.
   */
  readonly confirmationLag?: number | undefined;
  /** Signatures per `getSignaturesForAddress` call. */
  readonly signaturePageSize?: number | undefined;
  /** How many pages one account is paged back through before the gap is reported instead. */
  readonly maxSignaturePages?: number | undefined;
  /**
   * Transactions fetched in one poll.
   *
   * A bound rather than a limit anybody should reach. Without it, a first poll after a long
   * outage on a busy wallet would fetch every transaction in the gap in one pass and hold
   * the loop for minutes; with it, the poll stops at a slot boundary and the next one
   * carries on from there.
   */
  readonly maxTransactionsPerPoll?: number | undefined;
  /** Somewhere to say that a poll could not see all the way back to its cursor. */
  readonly warn?: ((message: string) => void) | undefined;
}

/** One entry of `getTokenAccountsByOwner`, as far as this file reads it. */
interface TokenAccountsResponse {
  readonly value: readonly { readonly pubkey: string }[];
}

interface SignatureEntry {
  readonly signature: string;
  readonly slot: number;
  readonly err: unknown;
}

interface TokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string };
}

interface TransactionResponse {
  readonly slot: number;
  readonly meta: {
    readonly err: unknown;
    readonly preBalances?: readonly number[];
    readonly postBalances?: readonly number[];
    readonly preTokenBalances?: readonly TokenBalance[];
    readonly postTokenBalances?: readonly TokenBalance[];
    readonly loadedAddresses?: {
      readonly writable?: readonly string[];
      readonly readonly?: readonly string[];
    };
  } | null;
  readonly transaction: {
    readonly message: {
      readonly accountKeys: readonly (string | { readonly pubkey: string; readonly signer?: boolean })[];
    };
  };
}

/** An account in a transaction, in the order the balance arrays are indexed by. */
interface TransactionAccount {
  readonly pubkey: string;
  readonly signer: boolean;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_TRANSACTIONS = 200;

export class SolanaAdapter implements ChainAdapter {
  readonly chain: ChainId = 'solana';
  readonly addressModel = 'pooled' as const;

  /**
   * Every account to watch for a wallet and a mint: the derived one, plus anything the chain
   * reported when it was asked.
   *
   * The derived address goes in the moment the pair is first seen and never changes, so this
   * is a cache of a computation rather than of an answer. What it also holds is the extra
   * accounts `getTokenAccountsByOwner` found, which is asked once per pair per process — a
   * wallet's set of token accounts is a property of how it was set up, not something that
   * changes between polls, and the catalogue of assets already requires a restart for the
   * same kind of reason.
   */
  private readonly watching = new Map<string, Set<string>>();

  /** Which token program owns a mint, learnt once. A mint's program never changes. */
  private readonly mintPrograms = new Map<string, string>();

  /** Pairs already asked about, so the extra lookup happens once and not every poll. */
  private readonly asked = new Set<string>();

  /**
   * Set when the endpoint refuses to list a wallet's token accounts.
   *
   * publicnode answers `getTokenAccountsByOwner` with HTTP 403. Nothing important depends on
   * it — the derived address is the account a payer pays — so the refusal is recorded, said
   * once, and not asked again.
   */
  private discoveryRefused = false;

  constructor(
    private readonly config: SolanaAdapterConfig,
    private readonly rpc: SolanaRpc,
    private readonly addressBook: SolanaAddressBook,
    private readonly oracle: SolanaPriceOracle,
  ) {}

  /**
   * Refused, because the address is not derivable on this chain.
   *
   * A pooled deposit address is a row in the merchant's wallet pool, chosen against the
   * invoices currently open on it. `WalletPoolService.allocate` answers instead. Throwing
   * rather than returning something plausible: a caller that reached this line has skipped
   * the allocation, and an address it invented would be one no merchant owns.
   */
  async deriveDepositTarget(_input: DeriveInput): Promise<DepositTarget> {
    throw new Error(
      'solana deposit addresses come from the merchant wallet pool, not from derivation',
    );
  }

  /**
   * Zero cost, honestly.
   *
   * Nothing here settles — the payer's transfer already reached the merchant's wallet — so
   * there is no fee to estimate. The SOL price is still reported because the snapshot's
   * shape requires it and because a reader of a gas snapshot expects to find one.
   */
  async probeGas(): Promise<GasSnapshot> {
    return {
      chain: this.chain,
      nativePriceUsd: await this.oracle.nativePriceUsd(),
      observedAt: Date.now(),
    };
  }

  async poll(cursor: PollCursor): Promise<PollResult> {
    const head = await this.rpc.slot();
    const safeHead = head - Math.max(0, this.config.confirmationLag ?? 0);
    /**
     * A cursor that is not a number is treated as no cursor, which scans one slot and
     * recovers. Refusing to scan at all would be a chain stalled for good by one bad row.
     */
    const stored = cursor === null ? null : Number(cursor);
    const from = stored === null || !Number.isFinite(stored) ? safeHead : stored + 1;
    if (from > safeHead) return { payments: [], cursor: cursor ?? String(safeHead) };

    /**
     * Our wallets. One unparseable row is skipped rather than fatal, for the same reason a
     * bad mint is: somebody's typo must not stop the chain being watched.
     */
    const owners = (await this.addressBook.watched()).filter((address) =>
      isSolanaAddress(address),
    );
    if (owners.length === 0) return { payments: [], cursor: String(safeHead) };

    const byMint = new Map<string, Asset>();
    let native: Asset | undefined;
    for (const asset of this.config.acceptedAssets) {
      if (asset.kind === 'native') {
        native = asset;
        continue;
      }
      if (asset.contract === undefined || !isSolanaAddress(asset.contract)) continue;
      byMint.set(asset.contract.trim(), asset);
    }
    if (byMint.size === 0 && native === undefined) return { payments: [], cursor: String(safeHead) };

    const ownerSet = new Set(owners);
    // Which account belongs to which of our wallets, for a response that omits `owner`.
    const accountOwner = new Map<string, string>();
    const toQuery: string[] = [];

    for (const [account, owner] of await this.accountsToWatch(owners, [...byMint.keys()])) {
      accountOwner.set(account, owner);
      toQuery.push(account);
    }
    // Lamports arrive at the wallet itself, so it is its own account to ask about.
    if (native !== undefined) toQuery.push(...owners);

    if (toQuery.length === 0) return { payments: [], cursor: String(safeHead) };

    const candidates = await this.signaturesInRange(toQuery, from, safeHead);
    if (candidates.length === 0) return { payments: [], cursor: String(safeHead) };

    /**
     * Oldest first, and cut at a slot boundary.
     *
     * The cut is what lets a bounded poll still make progress: everything up to and
     * including some slot is processed, the cursor moves to that slot, and the next poll
     * starts after it. Cutting mid-slot would move the cursor past transfers in the same
     * slot that were not processed.
     */
    const maxTransactions = this.config.maxTransactionsPerPoll ?? DEFAULT_MAX_TRANSACTIONS;
    candidates.sort((left, right) => left.slot - right.slot);
    let scanTo = safeHead;
    let batch = candidates;
    if (candidates.length > maxTransactions) {
      const boundary = candidates[maxTransactions - 1]!.slot;
      batch = candidates.filter((entry) => entry.slot <= boundary);
      scanTo = boundary;
      this.warn(
        `${candidates.length} transactions to read in slots ${from}–${safeHead}; taking ` +
          `${batch.length} up to slot ${boundary} and continuing next poll`,
      );
    }

    const transactions = (await this.rpc.batch(
      batch.map((entry) => ({
        method: 'getTransaction',
        params: [
          entry.signature,
          {
            commitment: 'finalized',
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
          },
        ],
      })),
    )) as (TransactionResponse | null)[];

    const payments: IncomingPayment[] = [];
    for (const [index, transaction] of transactions.entries()) {
      if (transaction === null) continue;
      payments.push(
        ...(await this.creditsIn(
          batch[index]!.signature,
          transaction,
          head,
          ownerSet,
          accountOwner,
          byMint,
          native,
        )),
      );
    }

    return { payments, cursor: String(scanTo) };
  }

  /**
   * Nothing to settle, ever.
   *
   * The payer paid the merchant's own wallet. The same answer TRON and TON give, for the
   * same reason.
   */
  async prepareSettlement(_batch: readonly SettlementRequest[]): Promise<null> {
    return noSettlementNeeded();
  }

  /**
   * Every account of ours to ask the chain about, as `[account, owner]`.
   *
   * The derived associated token account for each wallet and mint, always and without a
   * request; plus, once per pair, whatever else the wallet holds that mint in.
   */
  private async accountsToWatch(
    owners: readonly string[],
    mints: readonly string[],
  ): Promise<readonly (readonly [string, string])[]> {
    if (mints.length > 0) await this.learnMintPrograms(mints);

    const fresh: { readonly owner: string; readonly mint: string }[] = [];
    for (const owner of owners) {
      for (const mint of mints) {
        const key = `${owner}|${mint}`;
        let accounts = this.watching.get(key);
        if (accounts === undefined) {
          accounts = new Set(this.derivedAccounts(owner, mint));
          this.watching.set(key, accounts);
        }
        if (!this.asked.has(key) && !this.discoveryRefused) fresh.push({ owner, mint });
      }
    }

    if (fresh.length > 0) {
      try {
        const responses = (await this.rpc.batch(
          fresh.map((pair) => ({
            method: 'getTokenAccountsByOwner',
            params: [
              pair.owner,
              { mint: pair.mint },
              { commitment: 'finalized', encoding: 'jsonParsed' },
            ],
          })),
        )) as (TokenAccountsResponse | null)[];

        for (const [index, response] of responses.entries()) {
          const pair = fresh[index]!;
          const key = `${pair.owner}|${pair.mint}`;
          this.asked.add(key);
          const accounts = this.watching.get(key);
          for (const entry of response?.value ?? []) accounts?.add(entry.pubkey);
        }
      } catch (error) {
        /**
         * Not fatal, and not retried. The accounts this would have added are the ones a payer
         * does not use; the derived address is already being watched.
         */
        this.discoveryRefused = true;
        this.warn(
          'this endpoint will not list a wallet’s token accounts ' +
            `(${error instanceof Error ? error.message : String(error)}). Watching the derived ` +
            'associated token accounts only, which is where a payer’s transfer lands.',
        );
      }
    }

    const found: (readonly [string, string])[] = [];
    for (const owner of owners) {
      for (const mint of mints) {
        for (const account of this.watching.get(`${owner}|${mint}`) ?? []) {
          found.push([account, owner]);
        }
      }
    }
    return found;
  }

  /**
   * The associated token account, for the program that owns the mint.
   *
   * Both programs when that is not known: two addresses, one of which will simply never
   * receive anything, which costs one signature query per poll and no correctness. Better
   * than guessing the classic program and silently watching nothing for a Token-2022 mint.
   */
  private derivedAccounts(owner: string, mint: string): readonly string[] {
    const program = this.mintPrograms.get(mint);
    const programs = program === undefined ? [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] : [program];
    return programs.map((id) => associatedTokenAccount(owner, mint, id));
  }

  /**
   * Which token program owns each mint, asked once for the ones not yet known.
   *
   * It decides the derived address, so getting it wrong means watching an address that can
   * never receive. `getAccountInfo` is as basic as an RPC method gets; if it fails, the
   * derivation covers both programs instead and nothing is missed.
   */
  private async learnMintPrograms(mints: readonly string[]): Promise<void> {
    const unknown = mints.filter((mint) => !this.mintPrograms.has(mint));
    if (unknown.length === 0) return;

    try {
      const responses = (await this.rpc.batch(
        unknown.map((mint) => ({
          method: 'getAccountInfo',
          params: [mint, { commitment: 'finalized', encoding: 'jsonParsed' }],
        })),
      )) as ({ readonly value: { readonly owner?: string } | null } | null)[];

      for (const [index, response] of responses.entries()) {
        const owner = response?.value?.owner;
        if (owner !== undefined && isSolanaAddress(owner)) {
          this.mintPrograms.set(unknown[index]!, owner);
        }
      }
    } catch (error) {
      this.warn(
        `could not read which token program owns ${unknown.join(', ')} ` +
          `(${error instanceof Error ? error.message : String(error)}); watching both programs’ ` +
          'associated accounts instead',
      );
    }
  }

  /**
   * Every signature touching one of these accounts inside the slot range, once each.
   *
   * Paged newest-first because that is the only direction the RPC offers, and stopped as
   * soon as a page reaches below the cursor. A page cap bounds the work: reaching it means
   * the gap is wider than this many pages, which is said out loud rather than skipped
   * silently, because the slots not reached will not be visited again.
   */
  private async signaturesInRange(
    accounts: readonly string[],
    from: number,
    to: number,
  ): Promise<{ signature: string; slot: number }[]> {
    const pageSize = this.config.signaturePageSize ?? DEFAULT_PAGE_SIZE;
    const maxPages = this.config.maxSignaturePages ?? DEFAULT_MAX_PAGES;
    const seen = new Set<string>();
    const inRange: { signature: string; slot: number }[] = [];

    // One account at a time, but each page of each account in one batched request.
    for (const account of new Set(accounts)) {
      let before: string | undefined;
      let reachedCursor = false;

      for (let page = 0; page < maxPages; page++) {
        const [response] = await this.rpc.batch([
          {
            method: 'getSignaturesForAddress',
            params: [
              account,
              {
                commitment: 'finalized',
                limit: pageSize,
                ...(before === undefined ? {} : { before }),
              },
            ],
          },
        ]);
        const entries = (response ?? []) as readonly SignatureEntry[];
        if (entries.length === 0) {
          reachedCursor = true;
          break;
        }

        for (const entry of entries) {
          // A failed transaction moved nothing; not worth a `getTransaction` to confirm it.
          if (entry.err !== null && entry.err !== undefined) continue;
          if (entry.slot < from || entry.slot > to) continue;
          if (seen.has(entry.signature)) continue;
          seen.add(entry.signature);
          inRange.push({ signature: entry.signature, slot: entry.slot });
        }

        const oldest = entries[entries.length - 1]!;
        if (oldest.slot < from || entries.length < pageSize) {
          reachedCursor = true;
          break;
        }
        before = oldest.signature;
      }

      if (!reachedCursor) {
        this.warn(
          `${account}: more than ${maxPages * pageSize} signatures between slot ${from} and ` +
            `${to}; older ones in that range were not read`,
        );
      }
    }

    return inRange;
  }

  /** What one transaction moved into a wallet of ours, token by token and then lamports. */
  private async creditsIn(
    signature: string,
    transaction: TransactionResponse,
    head: number,
    owners: ReadonlySet<string>,
    accountOwner: ReadonlyMap<string, string>,
    byMint: ReadonlyMap<string, Asset>,
    native: Asset | undefined,
  ): Promise<readonly IncomingPayment[]> {
    const meta = transaction.meta;
    // A transaction that failed moved nothing, whatever its instructions said.
    if (meta === null || (meta.err !== null && meta.err !== undefined)) return [];

    const accounts = accountList(transaction);
    const slot = transaction.slot;
    const confirmations = head - slot + 1;
    const payments: IncomingPayment[] = [];

    const pre = new Map<number, bigint>();
    for (const entry of meta.preTokenBalances ?? []) {
      pre.set(entry.accountIndex, BigInt(entry.uiTokenAmount.amount));
    }

    for (const entry of meta.postTokenBalances ?? []) {
      const asset = byMint.get(entry.mint);
      if (asset === undefined) continue;

      const account = accounts[entry.accountIndex];
      const owner = entry.owner ?? (account === undefined ? undefined : accountOwner.get(account.pubkey));
      if (owner === undefined || !owners.has(owner)) continue;

      const delta = BigInt(entry.uiTokenAmount.amount) - (pre.get(entry.accountIndex) ?? 0n);
      if (delta <= 0n) continue;
      // The wallet signed for its own balance to go up: its own trade, not a payment to it.
      if (signedBy(accounts, owner)) continue;
      if ((await this.addressBook.lookup(owner)) === null) continue;

      const sender = tokenSender(meta, entry.mint, accounts);
      payments.push({
        chain: this.chain,
        txHash: signature,
        transferIndex: entry.accountIndex,
        to: owner,
        ...(sender === undefined ? {} : { from: sender }),
        asset,
        amount: delta,
        blockNumber: slot,
        confirmations,
      });
    }

    if (native !== undefined && meta.preBalances && meta.postBalances) {
      for (const [index, account] of accounts.entries()) {
        if (!owners.has(account.pubkey)) continue;
        // Its own transaction: the fee comes out of this balance and any increase is its own doing.
        if (account.signer) continue;

        const before = meta.preBalances[index];
        const after = meta.postBalances[index];
        if (before === undefined || after === undefined) continue;
        const delta = BigInt(after) - BigInt(before);
        if (delta <= 0n) continue;
        if ((await this.addressBook.lookup(account.pubkey)) === null) continue;

        payments.push({
          chain: this.chain,
          txHash: signature,
          transferIndex: index,
          to: account.pubkey,
          ...(accounts[0] === undefined ? {} : { from: accounts[0].pubkey }),
          asset: native,
          amount: delta,
          blockNumber: slot,
          confirmations,
        });
      }
    }

    return payments;
  }

  private warn(message: string): void {
    this.config.warn?.(message);
  }
}

/**
 * The accounts of a transaction, in the order the balance arrays index them.
 *
 * Static keys first, then the writable addresses a lookup table supplied, then the read-only
 * ones. Getting that order wrong shifts every index by however many static keys there are,
 * which does not fail — it reads somebody else's balance change as the merchant's.
 */
function accountList(transaction: TransactionResponse): readonly TransactionAccount[] {
  const keys = transaction.transaction.message.accountKeys.map((key) =>
    typeof key === 'string'
      ? { pubkey: key, signer: false }
      : { pubkey: key.pubkey, signer: key.signer === true },
  );
  const loaded = transaction.meta?.loadedAddresses;
  // An address from a lookup table is never a signer, so it cannot have signed for anything.
  for (const pubkey of loaded?.writable ?? []) keys.push({ pubkey, signer: false });
  for (const pubkey of loaded?.readonly ?? []) keys.push({ pubkey, signer: false });
  return keys;
}

function signedBy(accounts: readonly TransactionAccount[], pubkey: string): boolean {
  return accounts.some((account) => account.signer && account.pubkey === pubkey);
}

/**
 * Who sent it: the owner of the token account this mint left, and the fee payer if that
 * cannot be told.
 *
 * The sender is not identity and is not treated as such. It matters for one rule — a wallet
 * completing an invoice it underpaid — so an exchange's hot wallet or a payer's own wallet
 * are both the right answer, and the fee payer is a reasonable one when the source account's
 * owner is not reported.
 */
function tokenSender(
  meta: NonNullable<TransactionResponse['meta']>,
  mint: string,
  accounts: readonly TransactionAccount[],
): string | undefined {
  const post = new Map<number, bigint>();
  for (const entry of meta.postTokenBalances ?? []) {
    if (entry.mint !== mint) continue;
    post.set(entry.accountIndex, BigInt(entry.uiTokenAmount.amount));
  }

  for (const entry of meta.preTokenBalances ?? []) {
    if (entry.mint !== mint) continue;
    const after = post.get(entry.accountIndex) ?? 0n;
    if (after >= BigInt(entry.uiTokenAmount.amount)) continue;
    const owner = entry.owner ?? accounts[entry.accountIndex]?.pubkey;
    if (owner !== undefined) return owner;
  }

  return accounts[0]?.pubkey;
}

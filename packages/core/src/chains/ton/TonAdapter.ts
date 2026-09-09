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
import { isTonAddress, normalizeTonAddress } from './address.js';
import type { TonApi } from './TonApi.js';

/**
 * TON, for detecting payments into the merchant's own wallet, named by the comment.
 *
 * This is the one chain where the payer tells us which invoice they are paying. TON carries a
 * text comment on a transfer, and every wallet and exchange has a field for it, so an invoice
 * is identified exactly rather than inferred from its amount. Everything the pooled chains do
 * with a disambiguated amount — 20.05, 20.03, 20.011 — is a fallback here rather than the
 * mechanism.
 *
 * The address is the merchant's own wallet, from their pool, exactly as on TRON and Solana.
 * The transfer lands there and stays: no contract of ours in the path, nothing to sweep, no
 * key held. The comment is what tells two invoices on that one wallet apart.
 *
 * ## What replaced what
 *
 * The sketch this replaces polled `getTransactions` with no address in the query, credited
 * only native TON, and never ran: `watchableChains` excluded the chain because no adapter was
 * ever constructed for it, which is why a configured TON wallet could not put TON on a
 * checkout. Three things were wrong beyond that, and each one on its own is a lost payment:
 *
 *   - **Jettons were invisible.** USDT on TON is a jetton, which is what anybody paying in
 *     dollars on TON is holding. A jetton transfer does not reach the merchant's address; it
 *     reaches that wallet's jetton wallet, a contract derived from the owner and the jetton
 *     master. Watching the wallet address finds nothing at all.
 *   - **The comment was read from the wrong place.** On a native transfer it is the message
 *     body; on a jetton transfer it is inside the transfer's `forward_payload`. Reading only
 *     the first means every jetton payment arrives unnamed.
 *   - **Its cursor was logical time**, which does not fit the column a payment's position is
 *     recorded in.
 *
 * `TonApi` explains why an indexer answers all three and a node does not.
 *
 * ## What is credited, and what is skipped
 *
 * A jetton transfer is credited when its master is in the accepted set. A native transfer is
 * credited when the message body is empty or a text comment — which is what a wallet sends
 * — and skipped when it is anything else. That exclusion is load-bearing rather than tidy:
 * every jetton transfer also delivers a one-nanoton `jetton_notify` message to the owner's
 * wallet, and counting those as native TON payments would credit a nanoton of dust against
 * an open invoice for every jetton payment received.
 *
 * An aborted transaction is skipped: it moved nothing, whatever it says it intended.
 */

/** Where a transfer's recipient is looked up, to decide whether it is ours. */
export interface TonAddressBook {
  lookup(address: string): Promise<string | null>;
  /** Every wallet on this chain a transfer to which would be ours, as stored. */
  watched(): Promise<readonly string[]>;
}

/** Native price, for the gas model. Never consulted during a poll. */
export interface TonPriceOracle {
  nativePriceUsd(): Promise<number>;
}

export interface TonAdapterConfig {
  /**
   * Jetton masters we watch, with the merchant-facing assets they belong to, plus the native
   * asset if TON itself is accepted. Anything else is ignored: minting a jetton called USDT
   * costs a few cents.
   */
  readonly acceptedAssets: readonly Asset[];
  /** Records per request. toncenter serves up to 1000; 100 is plenty per wallet per poll. */
  readonly pageSize?: number | undefined;
  /** How many pages one wallet is read before the rest of the window is reported instead. */
  readonly maxPages?: number | undefined;
  /** Somewhere to say that a poll could not read all of its window. */
  readonly warn?: ((message: string) => void) | undefined;
}

/** A text comment, as the indexer decodes both kinds of payload. */
interface DecodedComment {
  readonly '@type'?: string;
  readonly comment?: string;
}

interface JettonTransfer {
  readonly source?: string | null;
  readonly destination?: string | null;
  readonly amount?: string;
  readonly jetton_master?: string;
  readonly transaction_hash?: string;
  readonly transaction_now?: number;
  readonly transaction_aborted?: boolean;
  readonly decoded_forward_payload?: DecodedComment | string | null;
}

interface TonTransaction {
  readonly hash?: string;
  readonly now?: number;
  readonly in_msg?: {
    readonly source?: string | null;
    readonly destination?: string | null;
    readonly value?: string | null;
    readonly message_content?: { readonly decoded?: DecodedComment | null } | null;
  } | null;
  readonly description?: { readonly aborted?: boolean } | null;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;

/**
 * Message bodies a native TON payment may carry.
 *
 * Empty is a plain transfer. A text comment is a plain transfer with a memo. Everything else
 * is a contract talking — `jetton_notify` above all, which accompanies every jetton payment
 * and would otherwise be credited as a nanoton of TON.
 */
const NATIVE_BODIES = new Set(['empty_cell', 'text_comment']);

export class TonAdapter implements ChainAdapter {
  readonly chain: ChainId = 'ton';
  readonly addressModel = 'pooled' as const;

  constructor(
    private readonly config: TonAdapterConfig,
    private readonly api: TonApi,
    private readonly addressBook: TonAddressBook,
    private readonly oracle: TonPriceOracle,
  ) {}

  /**
   * Refused, because the address is not derivable on this chain.
   *
   * The deposit address is a row in the merchant's wallet pool and the comment is generated
   * with it, inside the transaction that writes the invoice. `WalletPoolService.allocate` and
   * `DepositAddressDeriver.invoiceMemo` answer together. A caller that reached this line has
   * skipped both, and an address it invented would be one no merchant owns.
   */
  async deriveDepositTarget(_input: DeriveInput): Promise<DepositTarget> {
    throw new Error('ton deposit addresses come from the merchant wallet pool, not from derivation');
  }

  /**
   * Zero cost, honestly.
   *
   * Nothing here settles: the payer's transfer already reached the merchant's wallet. The TON
   * price is reported because the snapshot's shape requires it.
   */
  async probeGas(): Promise<GasSnapshot> {
    return {
      chain: this.chain,
      nativePriceUsd: await this.oracle.nativePriceUsd(),
      observedAt: Date.now(),
    };
  }

  async poll(cursor: PollCursor): Promise<PollResult> {
    const head = await this.api.utime();
    /**
     * A cursor that is not a number is treated as no cursor, which scans one second and
     * recovers. Refusing to scan would be a chain stalled for good by one bad row.
     */
    const stored = cursor === null ? null : Number(cursor);
    const from = stored === null || !Number.isFinite(stored) ? head : stored + 1;
    if (from > head) return { payments: [], cursor: cursor ?? String(head) };

    const wallets = (await this.addressBook.watched()).filter((address) => isTonAddress(address));
    if (wallets.length === 0) return { payments: [], cursor: String(head) };

    const jettons = new Map<string, Asset>();
    let native: Asset | undefined;
    for (const asset of this.config.acceptedAssets) {
      if (asset.kind === 'native') {
        native = asset;
        continue;
      }
      // One unparseable master is skipped, not fatal: a merchant's typo in a submitted
      // contract must not stop the chain being watched for everybody else.
      if (asset.contract === undefined || !isTonAddress(asset.contract)) continue;
      /**
       * Keyed by the canonical friendly form, not by raw hex.
       *
       * The indexer reports `jetton_master` raw and in upper case; the registry holds it
       * friendly. Comparing either against the other as a string matches nothing, and
       * "matches nothing" here means every USDT payment on TON is ignored — with no error,
       * on a chain that looks quiet. Both sides go through the codec instead.
       */
      jettons.set(normalizeTonAddress(asset.contract), asset);
    }
    if (jettons.size === 0 && native === undefined) return { payments: [], cursor: String(head) };

    const payments: IncomingPayment[] = [];
    for (const wallet of wallets) {
      /**
       * The form the indexer will actually match on, which is the friendly one.
       *
       * Raw is what it *answers* with, and passing raw back to it as a filter returns an
       * empty list with a 200 — not an error, because raw is a valid address, just one this
       * index does not key on. A bogus string gets a 422; the raw form of the right wallet
       * gets silence. That distinction cost an afternoon and is why this line has a comment.
       */
      const query = normalizeTonAddress(wallet);
      if (jettons.size > 0) {
        payments.push(...(await this.jettonPayments(wallet, query, from, head, jettons)));
      }
      if (native !== undefined) {
        payments.push(...(await this.nativePayments(wallet, query, from, head, native)));
      }
    }

    return { payments, cursor: String(head) };
  }

  /**
   * Nothing to settle, ever.
   *
   * The payer paid the merchant's own wallet. The same answer TRON and Solana give.
   */
  async prepareSettlement(_batch: readonly SettlementRequest[]): Promise<null> {
    return noSettlementNeeded();
  }

  /** Jetton transfers into one wallet, in the window. */
  private async jettonPayments(
    wallet: string,
    query: string,
    from: number,
    to: number,
    jettons: ReadonlyMap<string, Asset>,
  ): Promise<readonly IncomingPayment[]> {
    const rows = await this.pages<JettonTransfer>('jetton/transfers', 'jetton_transfers', {
      owner_address: query,
      direction: 'in',
      start_utime: from,
      end_utime: to,
    }, wallet);

    const payments: IncomingPayment[] = [];
    /**
     * Several transfers can share one transaction — a sender paying two of our wallets at
     * once — and the payment sink's identity is the transaction plus this index. Counted per
     * transaction so two transfers in one cannot collide, and offset by one so a jetton can
     * never share an index with the native transfer that carries index zero.
     */
    const seen = new Map<string, number>();

    for (const row of rows) {
      if (row.transaction_aborted === true) continue;
      const asset = row.jetton_master === undefined ? undefined : jettons.get(friendly(row.jetton_master));
      if (asset === undefined) continue;
      if (row.amount === undefined || row.transaction_hash === undefined) continue;
      if (row.destination === null || row.destination === undefined) continue;
      // The indexer was asked for this owner's incoming transfers; checked anyway, because
      // crediting on somebody else's row is the one mistake worth a second comparison.
      if (!sameAddress(row.destination, wallet)) continue;
      if ((await this.addressBook.lookup(wallet)) === null) continue;

      const amount = BigInt(row.amount);
      if (amount <= 0n) continue;

      const txHash = hashToHex(row.transaction_hash);
      const index = (seen.get(txHash) ?? 0) + 1;
      seen.set(txHash, index);

      const memo = commentOf(row.decoded_forward_payload);
      const sender = friendlyOrUndefined(row.source);

      payments.push({
        chain: this.chain,
        txHash,
        transferIndex: index,
        to: wallet,
        ...(sender === undefined ? {} : { from: sender }),
        ...(memo === undefined ? {} : { memo }),
        asset,
        amount,
        blockNumber: row.transaction_now ?? to,
        // Committed is final on TON; the registry asks for one at any value.
        confirmations: 1,
      });
    }

    return payments;
  }

  /** Native TON into one wallet, in the window. */
  private async nativePayments(
    wallet: string,
    query: string,
    from: number,
    to: number,
    native: Asset,
  ): Promise<readonly IncomingPayment[]> {
    const rows = await this.pages<TonTransaction>('transactions', 'transactions', {
      account: query,
      start_utime: from,
      end_utime: to,
    }, wallet);

    const payments: IncomingPayment[] = [];
    for (const row of rows) {
      if (row.description?.aborted === true) continue;
      const inbound = row.in_msg;
      if (!inbound || row.hash === undefined) continue;
      if (inbound.value === null || inbound.value === undefined) continue;

      const amount = BigInt(inbound.value);
      if (amount <= 0n) continue;

      /**
       * Only a wallet's own kind of message. Anything else is a contract talking to this
       * account, and the one that matters is `jetton_notify`: it accompanies every jetton
       * payment with one nanoton attached, and counting those as TON payments would put a
       * speck of dust against an open invoice each time somebody paid in USDT.
       */
      const decoded = inbound.message_content?.decoded ?? null;
      const kind = typeof decoded === 'object' && decoded !== null ? decoded['@type'] : undefined;
      if (decoded !== null && (kind === undefined || !NATIVE_BODIES.has(kind))) continue;

      if (inbound.destination !== null && inbound.destination !== undefined) {
        if (!sameAddress(inbound.destination, wallet)) continue;
      }
      if ((await this.addressBook.lookup(wallet)) === null) continue;

      const memo = commentOf(decoded);
      const sender = friendlyOrUndefined(inbound.source);

      payments.push({
        chain: this.chain,
        txHash: hashToHex(row.hash),
        // One transaction belongs to one account on TON, so a native credit is always the
        // first and only one at this hash.
        transferIndex: 0,
        to: wallet,
        ...(sender === undefined ? {} : { from: sender }),
        ...(memo === undefined ? {} : { memo }),
        asset: native,
        amount,
        blockNumber: row.now ?? to,
        confirmations: 1,
      });
    }

    return payments;
  }

  /**
   * Every record in the window, oldest first, paged.
   *
   * Ascending so that paging by offset is stable: with the newest first, a transfer arriving
   * mid-poll shifts every later page by one and one record is read twice or not at all. The
   * cap bounds the work, and reaching it is said out loud because the records beyond it are
   * inside a window the cursor is about to move past.
   */
  private async pages<T>(
    path: string,
    key: string,
    params: Readonly<Record<string, string | number>>,
    wallet: string,
  ): Promise<readonly T[]> {
    const pageSize = this.config.pageSize ?? DEFAULT_PAGE_SIZE;
    const maxPages = this.config.maxPages ?? DEFAULT_MAX_PAGES;
    const rows: T[] = [];

    for (let page = 0; page < maxPages; page++) {
      const body = await this.api.get<Record<string, T[] | undefined>>(path, {
        ...params,
        limit: pageSize,
        offset: page * pageSize,
        sort: 'asc',
      });
      const batch = body[key] ?? [];
      rows.push(...batch);
      if (batch.length < pageSize) return rows;

      if (page === maxPages - 1) {
        this.config.warn?.(
          `${wallet}: more than ${maxPages * pageSize} ${path} records between ` +
            `${params['start_utime']} and ${params['end_utime']}; the rest were not read`,
        );
      }
    }

    return rows;
  }
}

/** The comment on a transfer, from either kind of payload, or nothing. */
function commentOf(payload: DecodedComment | string | null | undefined): string | undefined {
  if (payload === null || payload === undefined) return undefined;
  // A string payload is an undecodable cell, which is not a comment anybody typed.
  if (typeof payload === 'string') return undefined;
  if (payload['@type'] !== 'text_comment') return undefined;
  const comment = payload.comment?.trim();
  return comment === undefined || comment === '' ? undefined : comment;
}

/**
 * A transaction hash as lowercase hex.
 *
 * The indexer returns base64, which carries `+`, `/` and `=` — characters that make a hash
 * awkward in a URL, in a log line and in the identity key the payment sink dedupes on. Hex is
 * also what a merchant pasting into an explorer will have.
 */
function hashToHex(hash: string): string {
  const normalized = hash.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('hex');
}

/** Our canonical form, or nothing when the field was absent or unparseable. */
function friendlyOrUndefined(address: string | null | undefined): string | undefined {
  if (address === null || address === undefined || address === '') return undefined;
  try {
    return normalizeTonAddress(address);
  } catch {
    return undefined;
  }
}

/** The canonical form, or the input unchanged when it is not an address at all. */
function friendly(address: string): string {
  try {
    return normalizeTonAddress(address);
  } catch {
    return address;
  }
}

function sameAddress(left: string, right: string): boolean {
  try {
    return normalizeTonAddress(left) === normalizeTonAddress(right);
  } catch {
    return false;
  }
}

/**
 * The memo a TON invoice carries, kept for the one caller outside this package that still
 * imports it.
 *
 * Superseded by `DepositAddressDeriver.invoiceMemo`, which is an HMAC of the invoice id under
 * the deployment's memo secret. The difference matters: this form is the invoice's uuid in
 * plain sight, and a comment is visible to anyone watching the wallet.
 *
 * @deprecated Use the deriver's memo, which is not guessable from the invoice id.
 */
export function tonMemo(invoiceId: string): string {
  return `AVEX-${invoiceId}`;
}

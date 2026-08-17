import type { ChainId } from '../types.js';
import {
  CONTROL_SELECTORS,
  DELEGATECALL_OPCODE,
  PROXY_SLOTS,
  SELECTORS,
  bytecodeContainsSelector,
  decodeString,
  decodeUint8,
  decodeUint256,
  encodeAddress,
  encodeCall,
  encodeUint256,
  selector,
  slotHoldsAddress,
} from './abi.js';
import { assessRisk } from './risk.js';
import {
  MAX_SANE_DECIMALS,
  RESERVED_SYMBOLS,
  type Erc20Metadata,
  type Finding,
  type VettingReport,
} from './types.js';

/**
 * Read-only chain access the probe needs.
 *
 * An interface so vetting can be tested exhaustively against contracts that would
 * be impractical to deploy, and so the RPC transport stays swappable.
 */
export interface EvmCaller {
  getCode(address: string): Promise<string>;
  call(to: string, data: string): Promise<string>;
  getStorageAt(address: string, slot: string): Promise<string>;

  /**
   * Simulate a call with contract code substituted at an address.
   *
   * The only practical way to observe transfer behaviour without spending
   * anything: place probe bytecode at an address that already holds the token,
   * then call it. `eth_call` executes without a signature, so no key is needed.
   *
   * Optional because not every provider supports state overrides. When it is
   * missing, transfer behaviour is reported `unknown` rather than assumed
   * harmless — which forces the contract to manual review.
   */
  callWithCodeOverride?(
    to: string,
    data: string,
    overrides: Readonly<Record<string, { code: string }>>,
  ): Promise<string>;
}

export interface ProbeOptions {
  readonly chain: ChainId;
  readonly contract: string;
  /**
   * An address already holding the token, used to observe a transfer. Without one
   * the fee-on-transfer and rebasing checks cannot run.
   */
  readonly holder?: string;
  /** Compiled `TransferProbe` runtime bytecode, placed at `holder` during simulation. */
  readonly transferProbeBytecode?: string;
  /** Whether this contract is on the curated global list. */
  readonly curated?: boolean;
  /** Symbols the configured price sources can quote. */
  readonly pricedSymbols?: readonly string[];
}

export class ContractProbe {
  constructor(private readonly caller: EvmCaller) {}

  async probe(options: ProbeOptions): Promise<VettingReport> {
    const findings: Finding[] = [];
    const { chain, contract } = options;

    const bytecode = await this.caller.getCode(contract).catch(() => '0x');
    if (bytecode === '0x' || bytecode === '') {
      findings.push({
        kind: 'no_code',
        status: 'present',
        severity: 'blocking',
        detail: 'no contract deployed at this address',
      });
      return this.finish(options, emptyMetadata(), findings);
    }

    const metadata = await this.readMetadata(contract, findings);
    if (metadata.decimals === null) {
      // Without decimals no amount can be computed, so nothing else matters.
      return this.finish(options, metadata, findings);
    }

    this.checkDecimals(metadata.decimals, findings);
    this.checkSupply(metadata.totalSupply, findings);
    this.checkSymbol(metadata.symbol, options, findings);

    await this.checkProxy(contract, bytecode, findings);
    this.checkIssuerControls(bytecode, findings);
    await this.checkTransferBehaviour(options, metadata.decimals, findings);

    return this.finish(options, metadata, findings);
  }

  private async readMetadata(contract: string, findings: Finding[]): Promise<Erc20Metadata> {
    const [symbol, name, decimals, totalSupply, balanceOfWorks] = await Promise.all([
      this.caller
        .call(contract, encodeCall(SELECTORS.symbol))
        .then(decodeString)
        .catch(() => null),
      this.caller
        .call(contract, encodeCall(SELECTORS.name))
        .then(decodeString)
        .catch(() => null),
      this.caller
        .call(contract, encodeCall(SELECTORS.decimals))
        .then(decodeUint8)
        .catch(() => null),
      this.caller
        .call(contract, encodeCall(SELECTORS.totalSupply))
        .then(decodeUint256)
        .catch(() => null),
      // The one call the settlement path cannot work without.
      this.caller
        .call(
          contract,
          encodeCall(SELECTORS.balanceOf, [
            encodeAddress('0x0000000000000000000000000000000000000001'),
          ]),
        )
        .then(() => true)
        .catch(() => false),
    ]);

    if (decimals === null || !balanceOfWorks) {
      findings.push({
        kind: 'not_erc20',
        status: 'present',
        severity: 'blocking',
        detail: [
          decimals === null ? 'decimals() did not answer' : null,
          !balanceOfWorks ? 'balanceOf(address) did not answer' : null,
        ]
          .filter(Boolean)
          .join('; '),
      });
    }

    return { symbol, name, decimals, totalSupply };
  }

  private checkDecimals(decimals: number, findings: Finding[]): void {
    if (decimals > MAX_SANE_DECIMALS) {
      findings.push({
        kind: 'decimals_unusual',
        status: 'present',
        severity: 'blocking',
        detail: `decimals is ${decimals}, above the supported maximum of ${MAX_SANE_DECIMALS}`,
      });
      return;
    }

    if (decimals === 0) {
      // Legal, but every invoice must then be a whole number of tokens, and the
      // rounding guard in the quote engine will reject most fiat amounts.
      findings.push({
        kind: 'decimals_unusual',
        status: 'present',
        severity: 'medium',
        detail: 'decimals is 0, so only whole-token amounts can be invoiced',
      });
    }
  }

  private checkSupply(totalSupply: bigint | null, findings: Finding[]): void {
    if (totalSupply === null) {
      findings.push({
        kind: 'zero_supply',
        status: 'unknown',
        severity: 'medium',
        detail: 'totalSupply() did not answer',
      });
      return;
    }
    if (totalSupply === 0n) {
      findings.push({
        kind: 'zero_supply',
        status: 'present',
        severity: 'blocking',
        detail: 'total supply is zero, so no payment could ever be made',
      });
    }
  }

  private checkSymbol(
    symbol: string | null,
    options: ProbeOptions,
    findings: Finding[],
  ): void {
    if (symbol === null) return;

    const upper = symbol.toUpperCase();
    if (RESERVED_SYMBOLS.includes(upper) && !options.curated) {
      // The attack this whole module exists for. A contract is not the asset it
      // names itself after unless it is the one on the curated list.
      findings.push({
        kind: 'symbol_impersonation',
        status: 'present',
        severity: 'high',
        detail:
          `claims the symbol ${upper}, which belongs to a major asset, but is not ` +
          'the curated contract for it',
      });
    }
  }

  private async checkProxy(
    contract: string,
    bytecode: string,
    findings: Finding[],
  ): Promise<void> {
    const slots = await Promise.all(
      [PROXY_SLOTS.implementation, PROXY_SLOTS.beacon, PROXY_SLOTS.eip1822].map((slot) =>
        this.caller.getStorageAt(contract, slot).catch(() => null),
      ),
    );

    const populated = slots.some((value) => value !== null && slotHoldsAddress(value));
    if (populated) {
      findings.push({
        kind: 'upgradeable_proxy',
        status: 'present',
        severity: 'high',
        detail:
          'a proxy implementation slot is populated, so the behaviour approved ' +
          'today can be replaced tomorrow',
      });
      return;
    }

    if (slots.every((value) => value === null)) {
      findings.push({
        kind: 'upgradeable_proxy',
        status: 'unknown',
        severity: 'medium',
        detail: 'storage could not be read, so upgradeability is undetermined',
      });
      return;
    }

    // No standard slot, but a contract that delegatecalls is forwarding somewhere.
    if (bytecode.toLowerCase().includes(DELEGATECALL_OPCODE)) {
      findings.push({
        kind: 'upgradeable_proxy',
        status: 'present',
        severity: 'medium',
        detail:
          'bytecode contains DELEGATECALL without a standard proxy slot; ' +
          'behaviour may be delegated elsewhere',
      });
      return;
    }

    findings.push({
      kind: 'upgradeable_proxy',
      status: 'absent',
      severity: 'info',
      detail: 'no proxy slot populated and no DELEGATECALL in bytecode',
    });
  }

  private checkIssuerControls(bytecode: string, findings: Finding[]): void {
    const present = Object.entries(CONTROL_SELECTORS)
      .filter(([, sel]) => bytecodeContainsSelector(bytecode, sel))
      .map(([signature]) => signature);

    if (present.length === 0) {
      findings.push({
        kind: 'issuer_controls',
        status: 'absent',
        severity: 'info',
        detail: 'no pause, freeze, blacklist or mint entry points found',
      });
      return;
    }

    findings.push({
      kind: 'issuer_controls',
      status: 'present',
      severity: 'medium',
      detail: `issuer can call: ${present.join(', ')}`,
    });
  }

  /**
   * Observe an actual transfer to detect a token that delivers less than it was
   * sent, or whose balances move on their own.
   */
  private async checkTransferBehaviour(
    options: ProbeOptions,
    decimals: number,
    findings: Finding[],
  ): Promise<void> {
    const unavailable = (reason: string): void => {
      // Never `absent`. A check that did not run has established nothing, and
      // `unknown` is what keeps this contract out of auto-approval.
      for (const kind of ['fee_on_transfer', 'rebasing'] as const) {
        findings.push({
          kind,
          status: 'unknown',
          severity: 'high',
          detail: reason,
        });
      }
    };

    if (!this.caller.callWithCodeOverride) {
      unavailable('the RPC provider does not support state overrides');
      return;
    }
    if (!options.holder || !options.transferProbeBytecode) {
      unavailable('no token holder was supplied to simulate a transfer from');
      return;
    }

    const amount = 10n ** BigInt(Math.min(decimals, 18));
    const recipient = '0x000000000000000000000000000000000000dEaD';

    try {
      const returned = await this.caller.callWithCodeOverride(
        options.holder,
        encodeCall(selectorProbe, [
          encodeAddress(options.contract),
          encodeAddress(recipient),
          encodeUint256(amount),
        ]),
        { [options.holder]: { code: options.transferProbeBytecode } },
      );

      const received = decodeUint256(returned);

      if (received < amount) {
        const feeBps = Number(((amount - received) * 10_000n) / amount);
        findings.push({
          kind: 'fee_on_transfer',
          status: 'present',
          severity: 'high',
          detail:
            `sending ${amount} delivered ${received}, a ${feeBps}bps shortfall; ` +
            'invoice tolerance must absorb this or every payment reads as underpaid',
        });
      } else {
        findings.push({
          kind: 'fee_on_transfer',
          status: 'absent',
          severity: 'info',
          detail: 'a simulated transfer delivered the full amount',
        });
      }

      if (received > amount) {
        findings.push({
          kind: 'rebasing',
          status: 'present',
          severity: 'high',
          detail: `a transfer of ${amount} delivered ${received}; balances do not track transfers`,
        });
      } else {
        findings.push({
          kind: 'rebasing',
          status: 'absent',
          severity: 'info',
          detail: 'the delivered amount matched the amount sent',
        });
      }
    } catch (error) {
      unavailable(
        `simulation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private finish(
    options: ProbeOptions,
    metadata: Erc20Metadata,
    findings: readonly Finding[],
  ): VettingReport {
    const assessment = assessRisk(findings, { ...(options.curated ? { curated: true } : {}) });

    // An asset no source can quote cannot be sold at a market rate, so the
    // merchant has to supply one. This is the seam back to the pricing engine.
    const priced = options.pricedSymbols ?? [];
    const symbol = metadata.symbol?.toUpperCase() ?? null;
    const requiresFixedRate = symbol === null || !priced.includes(symbol);

    return {
      chain: options.chain,
      contract: options.contract,
      metadata,
      findings,
      verdict: assessment.verdict,
      requiresFixedRate,
      probedAt: Date.now(),
    };
  }
}

function emptyMetadata(): Erc20Metadata {
  return { symbol: null, name: null, decimals: null, totalSupply: null };
}

/**
 * `TransferProbe.probeTransfer` — see contracts/TransferProbe.sol.
 *
 * Derived from the signature rather than pasted, so it cannot drift from the
 * contract it is meant to call.
 */
const selectorProbe = selector('probeTransfer(address,address,uint256)');

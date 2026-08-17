// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title Forwarder
 * @notice Per-invoice deposit address that can only ever pay one destination,
 *         optionally splitting a fixed-rate fee to one other.
 *
 * Every parameter is immutable and supplied as a constructor argument, so all of
 * them are part of the init code that CREATE2 hashes to produce this contract's
 * address. The address therefore commits to the destination *and to the fee*: no
 * key, no admin, and no action by AVEX can redirect funds sent here or take a
 * larger cut than was quoted when the address was handed out. Raising the fee
 * would produce a different address, which is a different deposit address, which
 * is not the one the payer was given.
 *
 * That is the property that lets a percentage fee coexist with a non-custodial
 * design. The money never passes through an account we control, and the split is
 * fixed at the moment the payer is quoted rather than at the moment we sweep.
 *
 * Deployment is deferred. The address is computed and handed to the payer while
 * no code exists at it; the contract is only deployed when funds have arrived,
 * in the same transaction that forwards them.
 */
contract Forwarder {
    address public immutable destination;
    /// Where the fee goes. Meaningless, and unread, when `feeBps` is zero.
    address public immutable feeDestination;
    /// Fee in basis points of the swept amount. Zero for subscription-only merchants.
    uint16 public immutable feeBps;

    /**
     * Hard ceiling on the fee, enforced by the code rather than by our policy.
     *
     * A forwarder that could be constructed to take everything would make the
     * immutability guarantee worthless — the address would commit to a number,
     * but the number could be 10000. 5% is well above any rate we would charge
     * and well below anything that could be called a confiscation.
     */
    uint16 public constant MAX_FEE_BPS = 500;
    uint16 private constant BPS_DENOMINATOR = 10_000;

    error ZeroDestination();
    error ZeroFeeDestination();
    error FeeTooHigh();
    error NativeTransferFailed();
    error TokenTransferFailed();

    constructor(address _destination, address _feeDestination, uint16 _feeBps) {
        if (_destination == address(0)) revert ZeroDestination();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        // A non-zero fee with nowhere to send it would burn the merchant's money
        // on every sweep. Rejected at construction, where it is still cheap.
        if (_feeBps > 0 && _feeDestination == address(0)) revert ZeroFeeDestination();

        destination = _destination;
        feeDestination = _feeDestination;
        feeBps = _feeBps;

        // Native funds sent before deployment are waiting in this address's
        // balance; sweep them as part of coming into existence.
        if (address(this).balance > 0) _sweepNative();
    }

    /// @notice Forward the full balance of `token`. Callable by anyone — the
    /// destination is fixed, so there is nothing to protect.
    function flush(address token) external {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;

        uint256 fee = _feeOn(balance);
        if (fee > 0 && !IERC20(token).transfer(feeDestination, fee)) revert TokenTransferFailed();

        /**
         * Re-read rather than sending `balance - fee`.
         *
         * Two things this gets right that subtraction does not. A fee-on-transfer
         * token takes its own cut out of the fee transfer, so our remaining
         * balance is lower than the arithmetic says and `balance - fee` would
         * revert for insufficient funds. And any rounding remainder ends up with
         * the merchant instead of stranded here, because "everything left" cannot
         * leave dust behind.
         */
        uint256 remaining = IERC20(token).balanceOf(address(this));
        if (remaining > 0 && !IERC20(token).transfer(destination, remaining)) {
            revert TokenTransferFailed();
        }
    }

    /// @notice Forward the full native balance.
    function flushNative() external {
        if (address(this).balance > 0) _sweepNative();
    }

    function _sweepNative() private {
        uint256 fee = _feeOn(address(this).balance);
        if (fee > 0) _send(feeDestination, fee);

        // Re-read, for the same reason as `flush`: a destination that reenters
        // during the fee transfer has already moved money, and subtraction would
        // then try to send more than is here.
        uint256 remaining = address(this).balance;
        if (remaining > 0) _send(destination, remaining);
    }

    /**
     * The fee, rounded down.
     *
     * Down rather than up so the remainder falls to the merchant. On a single
     * sweep the difference is one smallest unit; the reason to fix the direction
     * is that "we round our own fee in our favour" is indefensible however small
     * the number, and the merchant can verify the direction from this line.
     */
    function _feeOn(uint256 amount) private view returns (uint256) {
        if (feeBps == 0) return 0;
        return (amount * feeBps) / BPS_DENOMINATOR;
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}('');
        if (!ok) revert NativeTransferFailed();
    }

    receive() external payable {}
}

/**
 * @title ForwarderFactory
 * @notice Derives deposit addresses and settles them in batches.
 *
 * One instance per chain, deployed once. `predict` is the function the invoice
 * service calls to get a deposit address; `settleBatch` is what the settlement
 * queue calls when the chain is cheap enough to move funds.
 *
 * Note that the factory holds no configuration. The fee is not a property of the
 * factory that we could change between quoting an address and sweeping it — it is
 * an argument to both, and the two must be given the same values or they compute
 * different addresses. The caller is responsible for carrying the fee it quoted
 * through to settlement, which is why the invoice record stores it.
 */
contract ForwarderFactory {
    struct Settlement {
        bytes32 salt;
        address destination;
        address feeDestination;
        uint16 feeBps;
        /// Token to forward. `address(0)` means the native asset.
        address token;
    }

    event ForwarderDeployed(
        address indexed forwarder,
        address indexed destination,
        address indexed feeDestination,
        uint16 feeBps,
        bytes32 salt
    );

    /// @notice Init code for a forwarder bound to these parameters.
    function initCode(
        address destination,
        address feeDestination,
        uint16 feeBps
    ) public pure returns (bytes memory) {
        return
            abi.encodePacked(
                type(Forwarder).creationCode,
                abi.encode(destination, feeDestination, feeBps)
            );
    }

    /// @notice Deposit address for these parameters, deployed or not.
    /// @dev Mirrored off-chain in src/chains/evm/create2.ts; the two must agree.
    function predict(
        bytes32 salt,
        address destination,
        address feeDestination,
        uint16 feeBps
    ) public view returns (address) {
        bytes32 initCodeHash = keccak256(initCode(destination, feeDestination, feeBps));
        return
            address(
                uint160(
                    uint256(
                        keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                    )
                )
            );
    }

    function deploy(
        bytes32 salt,
        address destination,
        address feeDestination,
        uint16 feeBps
    ) public returns (address forwarder) {
        forwarder = address(new Forwarder{salt: salt}(destination, feeDestination, feeBps));
        emit ForwarderDeployed(forwarder, destination, feeDestination, feeBps, salt);
    }

    /**
     * @notice Deploy-if-needed and forward, for many invoices in one transaction.
     *
     * Batching is why deferring settlement pays off: the per-invoice cost of a
     * flush amortises against a single transaction's fixed overhead.
     */
    function settleBatch(Settlement[] calldata items) external {
        for (uint256 i = 0; i < items.length; ++i) {
            Settlement calldata item = items[i];
            address forwarder = predict(
                item.salt,
                item.destination,
                item.feeDestination,
                item.feeBps
            );

            if (forwarder.code.length == 0) {
                forwarder = deploy(
                    item.salt,
                    item.destination,
                    item.feeDestination,
                    item.feeBps
                );
            }

            if (item.token == address(0)) {
                Forwarder(payable(forwarder)).flushNative();
            } else {
                Forwarder(payable(forwarder)).flush(item.token);
            }
        }
    }
}

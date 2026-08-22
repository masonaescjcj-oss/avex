// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

// Hard ceiling on the fee, enforced by the code rather than by our policy.
//
// A forwarder that could be constructed to take everything would make the immutability
// guarantee worthless — the address would commit to a number, but the number could be 10000.
// 5% is well above any rate we would charge and well below anything that could be called a
// confiscation.
//
// At file scope so the factory that quotes an address and the logic that pays one out cannot
// hold two different ceilings. It is mirrored once more in `chains/evm/create2.ts`, where an
// invoice is refused before a payer is ever given an address that could not be settled.
uint16 constant MAX_FEE_BPS = 500;

/**
 * @title ForwarderLogic
 * @notice The code every per-invoice deposit address runs. Deployed once per chain.
 *
 * A deposit address is a minimal proxy — 45 bytes of EIP-1167, followed by 42 bytes of its
 * own parameters — that delegates every call here. So this contract is never the thing that
 * holds money: it is the thing that runs in the clone's context and moves it.
 *
 * ## Why the code is not in the deposit address any more
 *
 * It used to be. The previous version of this file put `destination`, `feeDestination` and
 * `feeBps` in Solidity immutables, which meant every deposit address deployed its own copy of
 * the whole contract: 1,567 bytes at 200 gas each, or 313,400 of the 385,291 gas a settlement
 * cost. Four fifths of the price of moving a merchant's money was writing bytecode identical
 * to the bytecode next door.
 *
 * That number is not an abstraction. `FeePolicy` refuses an invoice too small to carry its own
 * settlement, so the cost of the bytecode was the floor under what a merchant could sell —
 * about $6 on BNB Chain and tens of dollars on Ethereum. Shrinking it moves the floor.
 *
 * ## What is preserved exactly, and why that mattered more than the gas
 *
 * The guarantee is unchanged: a deposit address can only ever pay the destination it was
 * derived from, and can only ever take the fee it was quoted with.
 *
 * The parameters still live in the clone's own code, appended after the proxy — so they are
 * part of the init code that CREATE2 hashes, and the address commits to all three of them.
 * `config()` reads them back with EXTCODECOPY from `address(this)`, which under a delegatecall
 * is the clone. Nothing about the destination comes from the caller. `flush` stays callable by
 * anyone for the same reason it always was: there is nothing to protect.
 *
 * The tempting cheaper design was to leave the arguments out of the code and pass them in,
 * with the factory deriving the address from them — 45 bytes instead of 87. It was rejected.
 * It would have made a bug in the factory able to redirect a funded address, where today
 * nothing outside the address itself can, and 8,400 gas is not worth that.
 */
contract ForwarderLogic {
    /// The ceiling, re-exported so an integrator can read it off the deployed contract.
    uint16 public constant maxFeeBps = MAX_FEE_BPS;
    uint16 private constant BPS_DENOMINATOR = 10_000;

    /**
     * Where the parameters sit in a clone's code, and how many bytes they take.
     *
     * 45 is the length of the EIP-1167 runtime the proxy is made of; the arguments are appended
     * straight after it, as 20 + 20 + 2 bytes. Both numbers are duplicated in
     * `ForwarderFactory.cloneInitCode` and in `chains/evm/create2.ts`, and all three must
     * agree — a disagreement does not fail loudly, it reads somebody else's bytes as an address
     * and sends a payment there. The contract tests derive addresses from the TypeScript and
     * settle them through the Solidity for exactly that reason.
     */
    uint256 private constant ARGS_OFFSET = 45;
    uint256 private constant ARGS_LENGTH = 42;

    /**
     * This contract's own address, captured at construction.
     *
     * Read from the executing code under a delegatecall, so a clone sees the logic address
     * rather than its own — which is what makes the "am I a clone" check below possible.
     */
    address private immutable logic;

    error NotAClone();
    error FeeTooHigh();
    error ZeroDestination();
    error ZeroFeeDestination();
    error NativeTransferFailed();
    error TokenTransferFailed();

    constructor() {
        logic = address(this);
    }

    /**
     * @notice The three parameters this deposit address commits to.
     *
     * Read out of the clone's own code, and validated on every read rather than once at
     * construction. There is no constructor to validate in: a clone's init code copies bytes
     * and returns, so anything checked here is the only thing checked at all. Reverting is the
     * right answer to a malformed clone — the funds stay where they are, which is recoverable,
     * rather than being sent somewhere on a misread.
     */
    function config()
        public
        view
        returns (address payTo, address feeTo, uint16 bps)
    {
        /**
         * A direct call to the logic contract reads whatever happens to be at offset 45 of
         * *this* contract's code — a fragment of its own instructions, interpreted as an
         * address. Nothing is at risk, because this contract never holds funds, but a function
         * that answers a plausible-looking lie is worse than one that refuses.
         */
        if (address(this) == logic) revert NotAClone();

        assembly {
            // Scratch space. 42 bytes from 0x00 stops well short of the free memory pointer.
            extcodecopy(address(), 0x00, ARGS_OFFSET, ARGS_LENGTH)
            payTo := shr(96, mload(0x00))
            feeTo := shr(96, mload(0x14))
            bps := shr(240, mload(0x28))
        }

        if (payTo == address(0)) revert ZeroDestination();
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        if (bps > 0 && feeTo == address(0)) revert ZeroFeeDestination();
    }

    /**
     * @notice Where this address pays, what it takes, and where the cut goes.
     *
     * Three separate calls rather than one tuple because a merchant checking a deposit address
     * against what they were quoted does it with a block explorer, and an explorer shows a
     * function that returns one value. They cost nothing per deposit address: this code is
     * deployed once per chain, and a clone is 87 bytes whatever is in here.
     */
    function destination() external view returns (address value) {
        (value, , ) = config();
    }

    function feeDestination() external view returns (address value) {
        (, value, ) = config();
    }

    function feeBps() external view returns (uint16 value) {
        (, , value) = config();
    }

    /// @notice Forward the full balance of `token`. Callable by anyone — the destination is
    /// fixed by the address itself, so there is nothing to protect.
    function flush(address token) external {
        (address payTo, address feeTo, uint16 bps) = config();

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;

        uint256 fee = _feeOn(balance, bps);
        if (fee > 0 && !IERC20(token).transfer(feeTo, fee)) revert TokenTransferFailed();

        /**
         * Re-read rather than sending `balance - fee`.
         *
         * Two things this gets right that subtraction does not. A fee-on-transfer token takes
         * its own cut out of the fee transfer, so our remaining balance is lower than the
         * arithmetic says and `balance - fee` would revert for insufficient funds. And any
         * rounding remainder ends up with the merchant instead of stranded here, because
         * "everything left" cannot leave dust behind.
         */
        uint256 remaining = IERC20(token).balanceOf(address(this));
        if (remaining > 0 && !IERC20(token).transfer(payTo, remaining)) {
            revert TokenTransferFailed();
        }
    }

    /// @notice Forward the full native balance.
    function flushNative() external {
        if (address(this).balance == 0) return;
        (address payTo, address feeTo, uint16 bps) = config();

        uint256 fee = _feeOn(address(this).balance, bps);
        if (fee > 0) _send(feeTo, fee);

        // Re-read, for the same reason as `flush`: a destination that reenters during the fee
        // transfer has already moved money, and subtraction would then try to send more than
        // is here.
        uint256 remaining = address(this).balance;
        if (remaining > 0) _send(payTo, remaining);
    }

    /**
     * The fee, rounded down.
     *
     * Down rather than up so the remainder falls to the merchant. On a single sweep the
     * difference is one smallest unit; the reason to fix the direction is that "we round our
     * own fee in our favour" is indefensible however small the number, and the merchant can
     * verify the direction from this line.
     */
    function _feeOn(uint256 amount, uint16 bps) private pure returns (uint256) {
        if (bps == 0) return 0;
        return (amount * bps) / BPS_DENOMINATOR;
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}('');
        if (!ok) revert NativeTransferFailed();
    }

    /**
     * Native funds arriving at a clone that already exists.
     *
     * Before deployment they simply sit in the address's balance, which is why the settlement
     * path deploys and then calls `flushNative`. Afterwards the clone delegates the empty call
     * here, and refusing it would bounce a payer's transfer.
     */
    receive() external payable {}
}

/**
 * @title ForwarderFactory
 * @notice Derives deposit addresses and settles them in batches.
 *
 * One instance per chain, deployed once, alongside one `ForwarderLogic`. `predict` is the
 * function the invoice service mirrors to get a deposit address; `settleBatch` is what the
 * settlement queue calls when the chain is cheap enough to move funds.
 *
 * The factory holds no configuration beyond the logic address. The fee is not a property of
 * the factory that we could change between quoting an address and sweeping it — it is an
 * argument to both, and the two must be given the same values or they compute different
 * addresses. The caller is responsible for carrying the fee it quoted through to settlement,
 * which is why the invoice record stores it.
 *
 * Nor can the factory redirect anything. It builds init code and calls `flush`; the destination
 * a clone pays comes from the clone's own bytes. A hostile factory could deploy new clones at
 * new addresses, which is to say it could spend its own gas.
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

    /// The `ForwarderLogic` every clone delegates to. Immutable: a clone's code names it.
    address public immutable implementation;

    event ForwarderDeployed(
        address indexed forwarder,
        address indexed destination,
        address indexed feeDestination,
        uint16 feeBps,
        bytes32 salt
    );

    error FeeTooHigh();
    error ZeroDestination();
    error ZeroFeeDestination();
    error DeploymentFailed();

    constructor(address _implementation) {
        if (_implementation == address(0)) revert ZeroDestination();
        implementation = _implementation;
    }

    /**
     * @notice Init code for a deposit address bound to these parameters.
     *
     * The EIP-1167 minimal proxy, with two changes. The length in the init prefix is 87 rather
     * than 45, so the 42 bytes of parameters appended after the runtime are deposited as part
     * of the code — which is what puts them in the hash CREATE2 takes, and therefore in the
     * address. And nothing else: the 45 runtime bytes are the canonical ones, so the proxy
     * itself is the widely reviewed sequence rather than something written here.
     *
     * Laid out as: 10 bytes of init, 45 of runtime, then destination, feeDestination, feeBps.
     * `ForwarderLogic.ARGS_OFFSET` is the 45.
     */
    function cloneInitCode(
        address destination,
        address feeDestination,
        uint16 feeBps
    ) public view returns (bytes memory) {
        if (destination == address(0)) revert ZeroDestination();
        /**
         * Refused here as well as in `ForwarderLogic.config`, and the duplication is the point.
         *
         * This is the check that means we can never *quote* an address with an impossible fee.
         * The one in the logic is what means such an address could not pay out even if somebody
         * else's factory deployed it. A revert at settlement on an address a payer had already
         * funded would be the worst place to discover the fee was too high.
         */
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeBps > 0 && feeDestination == address(0)) revert ZeroFeeDestination();

        return
            abi.encodePacked(
                hex'3d605780600a3d3981f3363d3d373d3d3d363d73',
                implementation,
                hex'5af43d82803e903d91602b57fd5bf3',
                destination,
                feeDestination,
                feeBps
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
        bytes32 initCodeHash = keccak256(cloneInitCode(destination, feeDestination, feeBps));
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
        bytes memory code = cloneInitCode(destination, feeDestination, feeBps);
        assembly {
            forwarder := create2(0, add(code, 32), mload(code), salt)
        }
        if (forwarder == address(0)) revert DeploymentFailed();
        emit ForwarderDeployed(forwarder, destination, feeDestination, feeBps, salt);
    }

    /**
     * @notice Deploy-if-needed and forward, for many invoices in one transaction.
     *
     * Batching is why deferring settlement pays off: the per-invoice cost of a flush amortises
     * against a single transaction's fixed overhead.
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
                ForwarderLogic(payable(forwarder)).flushNative();
            } else {
                ForwarderLogic(payable(forwarder)).flush(item.token);
            }
        }
    }
}

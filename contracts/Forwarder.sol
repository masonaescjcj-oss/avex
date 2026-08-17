// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title Forwarder
 * @notice Per-invoice deposit address that can only ever pay one destination.
 *
 * `destination` is immutable and supplied as a constructor argument, so it is
 * part of the init code that CREATE2 hashes to produce this contract's address.
 * The address therefore commits to the destination: no key, no admin, and no
 * action by AVEX can redirect funds sent here. That property is what makes the
 * gateway non-custodial rather than merely promising not to touch the money.
 *
 * Deployment is deferred. The address is computed and handed to the payer while
 * no code exists at it; the contract is only deployed when funds have arrived,
 * in the same transaction that forwards them.
 */
contract Forwarder {
    address public immutable destination;

    error ZeroDestination();
    error NativeTransferFailed();
    error TokenTransferFailed();

    constructor(address _destination) {
        if (_destination == address(0)) revert ZeroDestination();
        destination = _destination;

        // Native funds sent before deployment are waiting in this address's
        // balance; sweep them as part of coming into existence.
        uint256 balance = address(this).balance;
        if (balance > 0) _sendNative(balance);
    }

    /// @notice Forward the full balance of `token`. Callable by anyone — the
    /// destination is fixed, so there is nothing to protect.
    function flush(address token) external {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;
        if (!IERC20(token).transfer(destination, balance)) revert TokenTransferFailed();
    }

    /// @notice Forward the full native balance.
    function flushNative() external {
        uint256 balance = address(this).balance;
        if (balance > 0) _sendNative(balance);
    }

    function _sendNative(uint256 amount) private {
        (bool ok, ) = destination.call{value: amount}('');
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
 */
contract ForwarderFactory {
    struct Settlement {
        bytes32 salt;
        address destination;
        /// Token to forward. `address(0)` means the native asset.
        address token;
    }

    event ForwarderDeployed(address indexed forwarder, address indexed destination, bytes32 salt);

    /// @notice Init code for a forwarder bound to `destination`.
    function initCode(address destination) public pure returns (bytes memory) {
        return abi.encodePacked(type(Forwarder).creationCode, abi.encode(destination));
    }

    /// @notice Deposit address for (`salt`, `destination`), deployed or not.
    /// @dev Mirrored off-chain in src/chains/evm/create2.ts; the two must agree.
    function predict(bytes32 salt, address destination) public view returns (address) {
        bytes32 initCodeHash = keccak256(initCode(destination));
        return
            address(
                uint160(
                    uint256(
                        keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                    )
                )
            );
    }

    function deploy(bytes32 salt, address destination) public returns (address forwarder) {
        forwarder = address(new Forwarder{salt: salt}(destination));
        emit ForwarderDeployed(forwarder, destination, salt);
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
            address forwarder = predict(item.salt, item.destination);

            if (forwarder.code.length == 0) {
                forwarder = deploy(item.salt, item.destination);
            }

            if (item.token == address(0)) {
                Forwarder(payable(forwarder)).flushNative();
            } else {
                Forwarder(payable(forwarder)).flush(item.token);
            }
        }
    }
}

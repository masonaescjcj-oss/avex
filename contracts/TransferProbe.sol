// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Probe {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title TransferProbe
 * @notice Measures what a token actually delivers, for contract vetting.
 *
 * Never deployed. Its runtime bytecode is injected at an address that already
 * holds the token under test, using an `eth_call` state override, and then called.
 * `eth_call` executes without a signature, so no key and no funds are needed and
 * nothing is spent.
 *
 * The measurement has to happen inside a single call because `eth_call` discards
 * state between calls — reading a balance, transferring, and reading again from
 * outside would observe no change at all.
 */
contract TransferProbe {
    /**
     * @notice Transfer `amount` and return how much actually arrived.
     * @return received Recipient balance delta.
     *
     * A result below `amount` means the token takes a cut in transit, which the
     * invoice tolerance must absorb or every payment reads as underpaid. A result
     * above it means balances do not track transfers at all.
     */
    function probeTransfer(
        address token,
        address recipient,
        uint256 amount
    ) external returns (uint256 received) {
        uint256 before = IERC20Probe(token).balanceOf(recipient);
        IERC20Probe(token).transfer(recipient, amount);
        uint256 after_ = IERC20Probe(token).balanceOf(recipient);

        // Underflow would mean the recipient's balance fell during a transfer to
        // them; report zero rather than reverting, so the finding is recorded.
        received = after_ > before ? after_ - before : 0;
    }
}

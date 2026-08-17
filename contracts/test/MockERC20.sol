// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockERC20
 * @notice Minimal token for exercising the forwarder in tests.
 *
 * `feeBps` makes it optionally take a cut in transit, so the vetting probe's
 * fee-on-transfer detection can be verified against a token that genuinely does
 * it rather than against a stub that merely reports it.
 */
contract MockERC20 {
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    uint16 public feeBps;

    mapping(address => uint256) public balanceOf;

    constructor(string memory _symbol, uint8 _decimals, uint16 _feeBps) {
        symbol = _symbol;
        decimals = _decimals;
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;

        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[to] += amount - fee;
        // The fee leaves circulation, as a real deflationary token would do.
        totalSupply -= fee;
        return true;
    }
}

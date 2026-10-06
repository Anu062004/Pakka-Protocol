// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Local tests only. Arc Testnet uses its faucet's real USDC ERC-20 interface.
contract MockUSDC is ERC20 {
    mapping(address => bool) public isBlacklisted;
    constructor() ERC20("Mock USDC", "mUSDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function burn(address from, uint256 amount) external { _burn(from, amount); }
    function setBlacklisted(address user, bool value) external { isBlacklisted[user] = value; }
    function _update(address from, address to, uint256 value) internal override {
        require(!isBlacklisted[from] && !isBlacklisted[to], "BLACKLISTED");
        super._update(from, to, value);
    }
}

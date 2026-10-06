// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @dev Local loss/yield and liquidity simulation, with configurable share decimals.
contract MockVault is ERC4626 {
    uint8 private immutable _offset;
    bool public illiquid;
    uint256 public depositCap = type(uint256).max;
    constructor(IERC20 asset_, uint8 offset_) ERC4626(asset_) ERC20("Mock Vault", "mVAULT") {
        _offset = offset_;
    }
    function _decimalsOffset() internal view override returns (uint8) { return _offset; }
    function addYield(uint256 assets) external { MockUSDC(asset()).mint(address(this), assets); }
    function simulateLoss(uint256 assets) external { MockUSDC(asset()).burn(address(this), assets); }
    function setIlliquid(bool value) external { illiquid = value; }
    function setDepositCap(uint256 value) external { depositCap = value; }
    function maxDeposit(address) public view override returns (uint256) { return depositCap; }
    function maxRedeem(address owner) public view override returns (uint256) {
        return illiquid ? 0 : super.maxRedeem(owner);
    }
}

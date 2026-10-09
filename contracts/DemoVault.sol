// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Demo vault. Yield is simulated by donating USDC to it; it does no real lending.
contract DemoVault is ERC4626 {
    error UnsupportedChain(uint256 chainId);
    error InvalidAsset();
    constructor(IERC20 usdc) ERC4626(usdc) ERC20("Pakka Demo Vault", "pDEMO") {
        if (block.chainid != 5042 && block.chainid != 5042002 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        if (address(usdc).code.length == 0) revert InvalidAsset();
        if (block.chainid != 31337 && address(usdc) != 0x3600000000000000000000000000000000000000) revert InvalidAsset();
    }
    function _decimalsOffset() internal pure override returns (uint8) { return 12; }
}

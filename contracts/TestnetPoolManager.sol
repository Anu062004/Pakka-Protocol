// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";

/// @notice Self-hosted Uniswap v4 core for the demo, not an official Uniswap deployment.
contract TestnetPoolManager is PoolManager {
    error UnsupportedChain(uint256 chainId);
    error InvalidOwner();

    constructor(address owner_) PoolManager(owner_) {
        if (block.chainid != 5042 && block.chainid != 5042002 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        if (owner_ == address(0)) revert InvalidOwner();
    }
}

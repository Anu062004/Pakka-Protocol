// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SeriesRegistry} from "./SeriesRegistry.sol";

/// @dev Shared callback authorization and ERC-20 settlement for swaps and demo LP operations.
abstract contract V4Client is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    SeriesRegistry public immutable registry;
    bytes32 internal _callbackHash;

    error UnsupportedChain(uint256 chainId);
    error InvalidConfiguration();
    error UnauthorizedCallback();
    error PoolNotSet();
    error SeriesExpired();
    error DeadlineExpired();
    error InvalidAmount();
    error InvalidReceiver();
    error SlippageExceeded();

    constructor(IPoolManager manager_, SeriesRegistry registry_) {
        if (block.chainid != 5042 && block.chainid != 5042002 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        if (address(manager_).code.length == 0 || address(registry_).code.length == 0) revert InvalidConfiguration();
        // The supplied manager is a trusted dependency; code presence alone is not verification.
        poolManager = manager_;
        registry = registry_;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || _callbackHash == bytes32(0) || keccak256(data) != _callbackHash) {
            revert UnauthorizedCallback();
        }
        _callbackHash = bytes32(0);
        return _execute(data);
    }

    function _execute(bytes calldata data) internal virtual returns (bytes memory);

    function _unlock(bytes memory data) internal returns (bytes memory result) {
        _callbackHash = keccak256(data);
        result = poolManager.unlock(data);
        if (_callbackHash != bytes32(0)) revert UnauthorizedCallback();
    }

    function _key(uint256 seriesId, bool active) internal view returns (PoolKey memory key) {
        SeriesRegistry.Series memory item = registry.getSeries(seriesId);
        if (active && block.timestamp >= item.expiry) revert SeriesExpired();
        if (!item.hasPool) revert PoolNotSet();
        SeriesRegistry.PoolKey memory p = item.poolKey;
        key = PoolKey(Currency.wrap(p.currency0), Currency.wrap(p.currency1), p.fee, p.tickSpacing, IHooks(p.hooks));
    }

    function _deadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert DeadlineExpired();
    }

    function _settle(Currency currency, int128 delta, address payer, address receiver) internal {
        if (delta < 0) {
            uint256 amount = uint256(-int256(delta));
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransferFrom(payer, address(poolManager), amount);
            if (poolManager.settle() != amount) revert InvalidAmount();
        } else if (delta > 0) {
            poolManager.take(currency, receiver, uint128(delta));
        }
    }
}

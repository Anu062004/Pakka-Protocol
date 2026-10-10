// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {SeriesRegistry} from "./SeriesRegistry.sol";
import {V4Client} from "./V4Client.sol";

/// @notice Owner-operated LP. Positions belong to this contract and pay only the registry's current owner,
/// so protocol liquidity follows an ownership transfer instead of being stranded with the old key.
/// @dev ponytail: one demo liquidity owner; use PositionManager if public LP positions are needed.
contract PoolSeeder is V4Client {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    struct Range {
        int24 tickLower;
        int24 tickUpper;
    }
    mapping(uint256 => Range[]) private _ranges;
    mapping(uint256 => mapping(bytes32 => bool)) private _known;
    struct Change {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        uint256 bound0;
        uint256 bound1;
    }

    error OnlyOwner();
    event PoolInitialized(uint256 indexed seriesId, uint160 sqrtPriceX96);
    event LiquidityChanged(uint256 indexed seriesId, int24 tickLower, int24 tickUpper,
        int256 liquidityDelta, int128 amount0, int128 amount1);

    constructor(IPoolManager manager_, SeriesRegistry registry_) V4Client(manager_, registry_) {}

    function owner() public view returns (address) {
        return registry.owner();
    }

    modifier onlyOwner() {
        if (msg.sender != owner()) revert OnlyOwner();
        _;
    }

    /// @notice Every range liquidity was ever added to, with what each still holds.
    /// A v4 position cannot be found without its range, so it is recorded here rather than off-chain.
    function positions(uint256 seriesId) external view returns (Range[] memory ranges, uint128[] memory liquidity) {
        ranges = _ranges[seriesId];
        liquidity = new uint128[](ranges.length);
        if (ranges.length == 0) return (ranges, liquidity);
        PoolId id = _key(seriesId, false).toId();
        for (uint256 i; i < ranges.length; ++i) {
            liquidity[i] = poolManager.getPositionLiquidity(id,
                Position.calculatePositionKey(address(this), ranges[i].tickLower, ranges[i].tickUpper, bytes32(0)));
        }
    }

    function initializePool(uint256 seriesId, uint160 sqrtPriceX96) external onlyOwner nonReentrant {
        poolManager.initialize(_key(seriesId, true), sqrtPriceX96);
        emit PoolInitialized(seriesId, sqrtPriceX96);
    }

    /// @notice Compute liquidity from maximum token budgets at the current pool price.
    /// Execution must still supply bounds because the pool price may change after this read.
    function liquidityForAmounts(uint256 seriesId, int24 lower, int24 upper, uint256 amount0, uint256 amount1)
        external view returns (uint128 liquidity)
    {
        PoolKey memory key = _key(seriesId, true);
        if (lower >= upper || lower % key.tickSpacing != 0 || upper % key.tickSpacing != 0) revert InvalidAmount();
        (uint160 price,,,) = poolManager.getSlot0(key.toId());
        if (price == 0) revert InvalidAmount();
        liquidity = LiquidityAmounts.getLiquidityForAmounts(price,
            TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1);
    }

    function addLiquidity(uint256 seriesId, int24 tickLower, int24 tickUpper, uint128 liquidity,
        uint256 max0, uint256 max1, uint256 deadline) external onlyOwner nonReentrant
        returns (int128 amount0, int128 amount1)
    {
        if (liquidity == 0 || liquidity > uint128(type(int128).max)) revert InvalidAmount();
        bytes32 range = keccak256(abi.encode(tickLower, tickUpper));
        if (!_known[seriesId][range]) {
            _known[seriesId][range] = true;
            _ranges[seriesId].push(Range(tickLower, tickUpper));
        }
        return _change(seriesId, tickLower, tickUpper, int256(uint256(liquidity)), max0, max1, deadline);
    }

    /// @notice Zero liquidity collects fees. Withdrawal remains available after series expiry.
    function removeLiquidity(uint256 seriesId, int24 tickLower, int24 tickUpper, uint128 liquidity,
        uint256 min0, uint256 min1, uint256 deadline) external onlyOwner nonReentrant
        returns (int128 amount0, int128 amount1)
    {
        if (liquidity > uint128(type(int128).max)) revert InvalidAmount();
        return _change(seriesId, tickLower, tickUpper, -int256(uint256(liquidity)), min0, min1, deadline);
    }

    function _change(uint256 id, int24 lower, int24 upper, int256 liquidityDelta,
        uint256 bound0, uint256 bound1, uint256 deadline) private returns (int128 amount0, int128 amount1)
    {
        _deadline(deadline);
        bytes memory data = abi.encode(Change(_key(id, liquidityDelta > 0), lower, upper, liquidityDelta, bound0, bound1));
        (amount0, amount1) = abi.decode(_unlock(data), (int128, int128));
        emit LiquidityChanged(id, lower, upper, liquidityDelta, amount0, amount1);
    }

    function _execute(bytes calldata data) internal override returns (bytes memory) {
        Change memory c = abi.decode(data, (Change));
        (BalanceDelta delta,) = poolManager.modifyLiquidity(c.key,
            ModifyLiquidityParams(c.tickLower, c.tickUpper, c.liquidityDelta, bytes32(0)), "");
        int128 amount0 = delta.amount0();
        int128 amount1 = delta.amount1();
        _bound(amount0, c.bound0, c.liquidityDelta > 0);
        _bound(amount1, c.bound1, c.liquidityDelta > 0);
        address account = owner();
        _settle(c.key.currency0, amount0, account, account);
        _settle(c.key.currency1, amount1, account, account);
        return abi.encode(amount0, amount1);
    }

    function _bound(int128 delta, uint256 limit, bool adding) private pure {
        if (adding) {
            if (delta < 0 && uint256(-int256(delta)) > limit) revert SlippageExceeded();
        } else if (delta < 0 || uint128(delta) < limit) revert SlippageExceeded();
    }
}

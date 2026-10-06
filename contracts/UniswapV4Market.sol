// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SeriesRegistry} from "./SeriesRegistry.sol";
import {V4Client} from "./V4Client.sol";
import {YieldToken} from "./YieldToken.sol";

/// @notice Exact-output PT buys and exact-input early sales on registered hook-free v4 pools.
contract UniswapV4Market is V4Client {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    struct Trade {
        PoolKey key;
        bool buy;
        bool quote;
        uint256 amount;
        uint256 limit;
        address payer;
        address receiver;
    }

    error IncompleteFill();
    error QuoteResult(uint256 input, uint256 output);
    error InvalidQuote();
    error PurchaseCapExceeded();
    error SeriesInactive();
    error IndexCircuitBreaker();
    error PriceAboveFace();
    event PTBought(uint256 indexed seriesId, address indexed buyer, address indexed receiver, uint256 pt, uint256 usdc);
    event PTSold(uint256 indexed seriesId, address indexed seller, address indexed receiver, uint256 pt, uint256 usdc);

    constructor(IPoolManager manager_, SeriesRegistry registry_) V4Client(manager_, registry_) {}

    function buyPT(uint256 seriesId, uint256 ptAmount, uint256 maxUsdc, address receiver, uint256 deadline)
        external nonReentrant returns (uint256 usdcSpent)
    {
        _deadline(deadline);
        _receiver(receiver);
        if (maxUsdc == 0) revert InvalidAmount();
        if (maxUsdc > ptAmount) revert PurchaseCapExceeded();
        (usdcSpent,) = abi.decode(_unlock(_trade(seriesId, true, false, ptAmount, maxUsdc, receiver)), (uint256, uint256));
        emit PTBought(seriesId, msg.sender, receiver, ptAmount, usdcSpent);
    }

    function sellPT(uint256 seriesId, uint256 ptAmount, uint256 minUsdc, address receiver, uint256 deadline)
        external nonReentrant returns (uint256 usdcReceived)
    {
        _deadline(deadline);
        _receiver(receiver);
        (,usdcReceived) = abi.decode(_unlock(_trade(seriesId, false, false, ptAmount, minUsdc, receiver)), (uint256, uint256));
        emit PTSold(seriesId, msg.sender, receiver, ptAmount, usdcReceived);
    }

    /// @notice Use eth_call / ethers .staticCall. Quotes simulate a swap and always roll its state back.
    /// No token balance or allowance is needed; actual execution can differ and must use bounds.
    function quoteBuyPT(uint256 seriesId, uint256 ptAmount) external nonReentrant returns (uint256 usdc) {
        (usdc,) = _quote(_trade(seriesId, true, true, ptAmount, 0, address(0)));
    }

    function quoteSellPT(uint256 seriesId, uint256 ptAmount) external nonReentrant returns (uint256 usdc) {
        (,usdc) = _quote(_trade(seriesId, false, true, ptAmount, 0, address(0)));
    }

    function poolState(uint256 seriesId) external view
        returns (bytes32 poolId, uint160 sqrtPriceX96, int24 tick, uint128 liquidity, uint24 lpFee)
    {
        PoolKey memory key = _key(seriesId, false);
        PoolId id = key.toId();
        poolId = PoolId.unwrap(id);
        (sqrtPriceX96, tick,, lpFee) = poolManager.getSlot0(id);
        liquidity = poolManager.getLiquidity(id);
    }

    function _trade(uint256 seriesId, bool buy, bool quote, uint256 amount, uint256 limit, address receiver)
        private view returns (bytes memory)
    {
        if (amount == 0 || amount > uint256(uint128(type(int128).max))) revert InvalidAmount();
        if (buy) {
            SeriesRegistry.Series memory item = registry.getSeries(seriesId);
            if (!registry.entryOpen(item.yieldToken)) revert SeriesInactive();
            if (!YieldToken(item.yieldToken).indexHealthy()) revert IndexCircuitBreaker();
        }
        return abi.encode(Trade(_key(seriesId, true), buy, quote, amount, limit, msg.sender, receiver));
    }

    function _receiver(address receiver) private view {
        if (receiver == address(0) || receiver == address(this) || receiver == address(poolManager)) revert InvalidReceiver();
    }

    function _execute(bytes calldata data) internal override returns (bytes memory) {
        Trade memory t = abi.decode(data, (Trade));
        bool assetIs0 = Currency.unwrap(t.key.currency0) == address(registry.assetToken());
        bool zeroForOne = t.buy ? assetIs0 : !assetIs0;
        uint160 facePrice = uint160(1 << 96); // PT and USDC both have 6 decimals.
        if (t.buy) {
            (uint160 current,,,) = poolManager.getSlot0(t.key.toId());
            if (current != 0 && (zeroForOne ? current <= facePrice : current >= facePrice)) revert PriceAboveFace();
        }
        BalanceDelta delta = poolManager.swap(t.key, SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: t.buy ? int256(t.amount) : -int256(t.amount),
            sqrtPriceLimitX96: t.buy ? facePrice :
                (zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
        }), "");
        int128 inputDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = zeroForOne ? delta.amount1() : delta.amount0();
        if (inputDelta >= 0 || outputDelta <= 0) revert IncompleteFill();
        uint256 input = uint256(-int256(inputDelta));
        uint256 output = uint128(outputDelta);
        if ((t.buy ? output : input) != t.amount) revert IncompleteFill();
        if (t.quote) revert QuoteResult(input, output);
        if (t.buy ? input > t.limit : output < t.limit) revert SlippageExceeded();
        _settle(t.key.currency0, delta.amount0(), t.payer, t.receiver);
        _settle(t.key.currency1, delta.amount1(), t.payer, t.receiver);
        return abi.encode(input, output);
    }

    function _quote(bytes memory data) private returns (uint256 input, uint256 output) {
        _callbackHash = keccak256(data);
        try poolManager.unlock(data) returns (bytes memory) {
            revert InvalidQuote();
        } catch (bytes memory reason) {
            // Callback revert unwinds the simulated pool state; clear our pre-call authorization too.
            _callbackHash = bytes32(0);
            if (reason.length != 68 || bytes4(reason) != QuoteResult.selector) {
                assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
            }
            assembly ("memory-safe") {
                input := mload(add(reason, 36))
                output := mload(add(reason, 68))
            }
        }
    }
}

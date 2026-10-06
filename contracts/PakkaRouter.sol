// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SeriesRegistry} from "./SeriesRegistry.sol";
import {UniswapV4Market} from "./UniswapV4Market.sol";
import {YieldToken} from "./YieldToken.sol";

/// @notice Atomic testnet shortcuts for fixed-rate purchases, ladders, exits and yield purchases.
/// @dev No administrator, arbitrary calls, standing downstream approvals or sweep of donated tokens.
contract PakkaRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct LadderLeg {
        uint256 seriesId;
        uint256 ptAmount;
        uint256 maxUsdc;
    }

    UniswapV4Market public immutable market;
    SeriesRegistry public immutable registry;
    IERC20 public immutable assetToken;

    error UnsupportedChain(uint256 chainId);
    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidReceiver();
    error InvalidLadder();
    error DeadlineExpired();
    error SeriesExpired();
    error SeriesNotExpired();
    error BudgetExceeded();
    error SlippageExceeded();
    error VaultIlliquid();
    error UnexpectedTransferAmount();
    error PurchaseCapExceeded();
    error SeriesInactive();
    error IndexCircuitBreaker();

    event Locked(uint256 indexed seriesId, address indexed caller, address indexed receiver,
        uint256 ptAmount, uint256 usdcSpent);
    event LadderBuilt(address indexed caller, address indexed receiver, uint256 legs,
        uint256 usdcSpent, uint256 usdcRefunded);
    event SoldEarly(uint256 indexed seriesId, address indexed caller, address indexed receiver,
        uint256 ptAmount, uint256 usdcReceived);
    event CashedOut(uint256 indexed seriesId, address indexed caller, address indexed receiver,
        uint256 ptAmount, uint256 output, bool toAssets);
    event YieldBought(uint256 indexed seriesId, address indexed caller, address indexed receiver,
        uint256 assetsDeposited, uint256 ytAmount, uint256 usdcReturned);

    constructor(UniswapV4Market market_) {
        if (block.chainid != 5042002 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        if (address(market_).code.length == 0) revert InvalidConfiguration();
        SeriesRegistry registry_ = market_.registry();
        if (address(registry_).code.length == 0) revert InvalidConfiguration();
        IERC20 asset_ = registry_.assetToken();
        if (address(asset_).code.length == 0) revert InvalidConfiguration();
        if (block.chainid == 5042002 && address(asset_) != 0x3600000000000000000000000000000000000000) {
            revert InvalidConfiguration();
        }
        // The immutable market/registry are trusted dependencies, not caller-selected targets.
        market = market_;
        registry = registry_;
        assetToken = asset_;
    }

    /// @notice Buy exact PT. Pull the maximum budget and refund unused USDC to the caller.
    function lock(uint256 seriesId, uint256 ptAmount, uint256 maxUsdc, address receiver, uint256 deadline)
        external nonReentrant returns (uint256 usdcSpent)
    {
        _validate(receiver, deadline);
        _purchase(seriesId, ptAmount, maxUsdc);
        _pull(assetToken, maxUsdc);
        usdcSpent = _buy(seriesId, ptAmount, maxUsdc, receiver, deadline);
        _refund(maxUsdc - usdcSpent);
    }

    /// @notice Buy all legs or none. Maturities must strictly increase; caps may sum above the total budget.
    function buildLadder(LadderLeg[] calldata legs, uint256 maxTotalUsdc, address receiver, uint256 deadline)
        external nonReentrant returns (uint256 usdcSpent)
    {
        _validate(receiver, deadline);
        if (legs.length == 0) revert InvalidLadder();
        if (maxTotalUsdc == 0) revert InvalidAmount();
        uint256 previousExpiry;
        for (uint256 i; i < legs.length; ++i) {
            LadderLeg calldata leg = legs[i];
            uint256 expiry = _purchase(leg.seriesId, leg.ptAmount, leg.maxUsdc).expiry;
            if (expiry <= previousExpiry) revert InvalidLadder();
            previousExpiry = expiry;
        }
        _pull(assetToken, maxTotalUsdc);
        for (uint256 i; i < legs.length; ++i) {
            uint256 remaining = maxTotalUsdc - usdcSpent;
            if (remaining == 0) revert BudgetExceeded();
            LadderLeg calldata leg = legs[i];
            usdcSpent += _buy(leg.seriesId, leg.ptAmount, Math.min(leg.maxUsdc, remaining), receiver, deadline);
        }
        uint256 refund = maxTotalUsdc - usdcSpent;
        _refund(refund);
        emit LadderBuilt(msg.sender, receiver, legs.length, usdcSpent, refund);
    }

    function sellEarly(uint256 seriesId, uint256 ptAmount, uint256 minUsdc, address receiver, uint256 deadline)
        external nonReentrant returns (uint256 usdcReceived)
    {
        _validate(receiver, deadline);
        SeriesRegistry.Series memory item = _active(seriesId);
        if (ptAmount == 0) revert InvalidAmount();
        IERC20 pt = IERC20(item.principalToken);
        _pull(pt, ptAmount);
        usdcReceived = _sell(seriesId, pt, ptAmount, minUsdc, receiver, deadline);
        emit SoldEarly(seriesId, msg.sender, receiver, ptAmount, usdcReceived);
    }

    /// @notice Minimum output is in USDC units when toAssets, otherwise in vault-share units.
    /// Share exits do not check maxRedeem, so they remain usable when the vault is illiquid.
    function cashOut(uint256 seriesId, uint256 ptAmount, address receiver, bool toAssets,
        uint256 minOutput, uint256 deadline) external nonReentrant returns (uint256 output)
    {
        _validate(receiver, deadline);
        if (ptAmount == 0) revert InvalidAmount();
        SeriesRegistry.Series memory item = registry.getSeries(seriesId);
        if (block.timestamp < item.expiry) revert SeriesNotExpired();
        YieldToken yt = YieldToken(item.yieldToken);
        uint256 index = yt.settleExpiry();
        if (toAssets) {
            uint256 shares = Math.mulDiv(ptAmount, yt.INDEX_UNIT(), index);
            if (shares > yt.vault().maxRedeem(item.yieldToken)) revert VaultIlliquid();
        }
        // YieldToken burns its caller's PT; holding the approved amount here enables atomic redemption.
        _pull(IERC20(item.principalToken), ptAmount);
        output = yt.redeemPT(ptAmount, receiver, toAssets);
        if (output < minOutput) revert SlippageExceeded();
        emit CashedOut(seriesId, msg.sender, receiver, ptAmount, output, toAssets);
    }

    /// @notice Buy YT synthetically: split a deposit, sell all minted PT, then deliver the YT.
    /// The caller funds assets and receives the PT-sale proceeds; minUsdcReturned bounds the net cost.
    function buyYield(uint256 seriesId, uint256 assets, uint256 minYT, uint256 minUsdcReturned,
        address receiver, uint256 deadline) external nonReentrant returns (uint256 ytAmount, uint256 usdcReturned)
    {
        _validate(receiver, deadline);
        SeriesRegistry.Series memory item = _active(seriesId);
        if (assets == 0) revert InvalidAmount();
        YieldToken yt = YieldToken(item.yieldToken);
        if (receiver == address(yt)) revert InvalidReceiver();
        _pull(assetToken, assets);
        assetToken.forceApprove(address(yt), assets);
        ytAmount = yt.splitFromAssets(assets, address(this));
        assetToken.forceApprove(address(yt), 0);
        if (ytAmount < minYT) revert SlippageExceeded();
        usdcReturned = _sell(seriesId, IERC20(item.principalToken), ytAmount, minUsdcReturned, msg.sender, deadline);
        IERC20(address(yt)).safeTransfer(receiver, ytAmount);
        emit YieldBought(seriesId, msg.sender, receiver, assets, ytAmount, usdcReturned);
    }

    function _validate(address receiver, uint256 deadline) private view {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (receiver == address(0) || receiver == address(this) || receiver == address(market) ||
            receiver == address(market.poolManager())) revert InvalidReceiver();
    }

    function _active(uint256 id) private view returns (SeriesRegistry.Series memory item) {
        item = registry.getSeries(id);
        if (block.timestamp >= item.expiry) revert SeriesExpired();
    }

    function _purchase(uint256 id, uint256 amount, uint256 limit) private view
        returns (SeriesRegistry.Series memory item)
    {
        if (amount == 0 || limit == 0) revert InvalidAmount();
        if (limit > amount) revert PurchaseCapExceeded();
        item = _active(id);
        if (!registry.entryOpen(item.yieldToken)) revert SeriesInactive();
        if (!YieldToken(item.yieldToken).indexHealthy()) revert IndexCircuitBreaker();
    }

    function _buy(uint256 id, uint256 amount, uint256 limit, address receiver, uint256 deadline)
        private returns (uint256 spent)
    {
        assetToken.forceApprove(address(market), limit);
        spent = market.buyPT(id, amount, limit, receiver, deadline);
        assetToken.forceApprove(address(market), 0);
        emit Locked(id, msg.sender, receiver, amount, spent);
    }

    function _sell(uint256 id, IERC20 pt, uint256 amount, uint256 minimum, address receiver, uint256 deadline)
        private returns (uint256 output)
    {
        pt.forceApprove(address(market), amount);
        output = market.sellPT(id, amount, minimum, receiver, deadline);
        pt.forceApprove(address(market), 0);
    }

    function _pull(IERC20 token, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnexpectedTransferAmount();
    }

    function _refund(uint256 amount) private {
        // Refund this call's unused budget only; unsolicited router balances are never included.
        if (amount != 0) assetToken.safeTransfer(msg.sender, amount);
    }
}

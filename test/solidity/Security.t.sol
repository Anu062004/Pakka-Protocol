// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockUSDC} from "../../contracts/test/MockUSDC.sol";
import {MockVault} from "../../contracts/test/MockVault.sol";
import {YieldToken, ISeriesEntryPolicy} from "../../contracts/YieldToken.sol";
import {PrincipalToken} from "../../contracts/PrincipalToken.sol";
import {SeriesRegistry} from "../../contracts/SeriesRegistry.sol";
import {TestnetPoolManager} from "../../contracts/TestnetPoolManager.sol";
import {UniswapV4Market} from "../../contracts/UniswapV4Market.sol";
import {PakkaRouter} from "../../contracts/PakkaRouter.sol";
import {PoolSeeder} from "../../contracts/PoolSeeder.sol";
import {Tijori} from "../../contracts/Tijori.sol";
import {TijoriFactory} from "../../contracts/TijoriFactory.sol";

interface VmSecurity {
    function warp(uint256) external;
    function roll(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}

contract SystemHandler {
    Tijori public immutable tijori;
    MockUSDC public immutable asset;
    PrincipalToken public immutable pt;
    address public constant PAYEE = address(0xBEEF);
    uint256 public successfulActions;
    constructor(Tijori t, MockUSDC a, PrincipalToken p) { tijori = t; asset = a; pt = p; }
    function buy(uint64 raw) external {
        uint256 n = 1 + uint256(raw) % 1_000_000;
        if (asset.balanceOf(address(tijori)) < n) return;
        try tijori.lock(1, n, n, block.timestamp + 60) { successfulActions++; } catch {}
    }
    function pay(uint64 raw) external {
        uint256 n = 1 + uint256(raw) % 1_000_000;
        if (asset.balanceOf(address(tijori)) < n || tijori.paymentRemaining(PAYEE) < n) return;
        try tijori.pay(PAYEE, n) { successfulActions++; } catch {}
    }
    function redeem() external {
        uint256 n = pt.balanceOf(address(tijori));
        if (n == 0) return;
        try tijori.cashOut(1, n, true, 0, block.timestamp + 60) { successfulActions++; } catch {}
    }
}

contract SecurityTest {
    VmSecurity internal constant vm = VmSecurity(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant U = 1_000_000;
    address internal constant AGENT = address(0xA100);
    MockUSDC internal asset;
    MockVault internal vault;
    SeriesRegistry internal registry;
    YieldToken internal yt;
    PrincipalToken internal pt;
    UniswapV4Market internal market;
    PakkaRouter internal router;
    Tijori internal tijori;
    uint256 internal expiry;
    SystemHandler internal handler;

    function setUp() public {
        asset = new MockUSDC(); vault = new MockVault(asset, 12);
        registry = new SeriesRegistry(asset, address(this));
        TestnetPoolManager manager = new TestnetPoolManager(address(this));
        market = new UniswapV4Market(manager, registry); router = new PakkaRouter(market);
        PoolSeeder seeder = new PoolSeeder(manager, registry);
        expiry = block.timestamp + 3 days;
        yt = new YieldToken(vault, expiry, "SECURITY", ISeriesEntryPolicy(address(registry)));
        pt = yt.principalToken(); registry.registerSeries(yt);
        asset.mint(address(this), 2000 * U);
        asset.approve(address(yt), 400 * U); yt.splitFromAssets(400 * U, address(this));
        bool assetIs0 = address(asset) < address(pt);
        registry.setPoolKey(1, SeriesRegistry.PoolKey({currency0: assetIs0 ? address(asset) : address(pt),
            currency1: assetIs0 ? address(pt) : address(asset), fee: 500, tickSpacing: 10, hooks: address(0)}));
        seeder.initializePool(1, uint160(Math.sqrt((1 << 192) * (assetIs0 ? U : 990000) / (assetIs0 ? 990000 : U))));
        asset.approve(address(seeder), 400 * U); pt.approve(address(seeder), 400 * U);
        seeder.addLiquidity(1, -600, 600, uint128(10000 * U), 400 * U, 400 * U, expiry - 1);
        TijoriFactory factory = new TijoriFactory(router);
        tijori = Tijori(factory.create(AGENT, 50 * U));
        asset.approve(address(tijori), 100 * U); tijori.deposit(100 * U);
        tijori.setPayeeCap(address(0xBEEF), 10 * U);
        handler = new SystemHandler(tijori, asset, pt);
        tijori.setAgent(address(handler));
        handler.buy(uint64(U - 1)); // Make the invariant non-vacuous before fuzzing.
    }

    function testDirectSplitCapAndVaultLimits() public {
        asset.approve(address(yt), 100 * U); yt.splitFromAssets(100 * U, address(this));
        vm.expectRevert(YieldToken.SeriesCapExceeded.selector); yt.splitFromAssets(1, address(this));
        yt.merge(U, address(this), false);
        vault.setDepositCap(0);
        vm.expectRevert(YieldToken.VaultDepositLimit.selector); yt.splitFromAssets(U, address(this));
        vault.setIlliquid(true);
        vm.expectRevert(YieldToken.VaultRedeemLimit.selector); yt.merge(U, address(this), true);
        yt.merge(U, address(this), false);
    }
    function testEntryPauseCannotDisableExits() public {
        registry.setEntriesPaused(true);
        vm.expectRevert(YieldToken.SeriesInactive.selector); yt.splitFromAssets(U, address(this));
        vm.expectRevert(PakkaRouter.SeriesInactive.selector); router.lock(1, U, U, address(this), expiry - 1);
        yt.merge(U, address(this), false); yt.claimInterest(address(this), false);
        vm.warp(expiry); yt.redeemPT(U, address(this), false);
    }
    function testIndexJumpNeverPoisonsStoredIndex() public {
        uint256 index = yt.pyIndexStored(); vault.addYield(10 * U);
        assert(!yt.indexHealthy());
        vm.expectRevert(YieldToken.IndexCircuitBreaker.selector); yt.splitFromAssets(U, address(this));
        yt.checkpointIndex(); assert(yt.pyIndexStored() == index);
        yt.merge(U, address(this), false); vault.simulateLoss(20 * U);
        assert(!yt.indexHealthy()); yt.claimInterest(address(this), false);
    }
    function testFuzzFaceValueCeiling(uint96 excess) public {
        uint256 cap = U + 1 + uint256(excess) % U;
        vm.expectRevert(PakkaRouter.PurchaseCapExceeded.selector); router.lock(1, U, cap, address(this), expiry - 1);
        vm.expectRevert(UniswapV4Market.PurchaseCapExceeded.selector); market.buyPT(1, U, cap, address(this), expiry - 1);
    }
    function testRollingLimitAndBlacklistIsolation() public {
        tijori.setAgent(AGENT);
        uint256 boundary = (block.timestamp / 30 days + 1) * 30 days;
        vm.warp(boundary - 1); vm.prank(AGENT); tijori.pay(address(0xBEEF), 10 * U);
        vm.warp(boundary + 1); assert(tijori.paymentRemaining(address(0xBEEF)) == 0);
        vm.warp(boundary - 1 + 30 days); assert(tijori.paymentRemaining(address(0xBEEF)) == 10 * U);
        asset.setBlacklisted(address(0xBEEF), true);
        vm.expectRevert(Tijori.PayeeBlacklisted.selector); vm.prank(AGENT); tijori.pay(address(0xBEEF), U);
        tijori.setPayeeCap(address(0xCAFE), U); vm.prank(AGENT); tijori.pay(address(0xCAFE), U);
    }
    function testOwnerRecoveryWhileAgentPaused() public {
        tijori.setPaused(true); tijori.withdraw(asset, U);
        yt.merge(U, address(tijori), false);
        tijori.withdrawVaultShares(1, vault.balanceOf(address(tijori)));
        assert(vault.balanceOf(address(tijori)) == 0);
    }
    function testFullLockSettleCashOutPayFlow() public {
        address priya = address(0x1234); asset.transfer(priya, 10 * U);
        vm.prank(priya); asset.approve(address(router), U);
        vm.prank(priya); router.lock(1, U, U, priya, expiry - 1);
        vault.addYield(U); vm.warp(expiry); vm.roll(block.number + 1);
        yt.settleExpiry(); vm.prank(priya); pt.approve(address(router), U);
        vm.prank(priya); router.cashOut(1, U, priya, true, U - 1, expiry + 100);
        handler.redeem(); handler.pay(uint64(U - 1));
        assert(asset.balanceOf(address(0xBEEF)) == U);
    }
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1); targets[0] = address(handler);
    }
    function invariantApprovalsCustodyAndPaymentLimits() public view {
        assert(handler.successfulActions() > 0);
        assert(asset.allowance(address(tijori), address(router)) == 0);
        assert(pt.allowance(address(tijori), address(router)) == 0);
        assert(asset.allowance(address(router), address(market)) == 0);
        assert(asset.allowance(address(yt), address(vault)) == 0);
        assert(asset.balanceOf(address(router)) == 0 && pt.balanceOf(address(router)) == 0);
        assert(asset.balanceOf(address(market)) == 0 && pt.balanceOf(address(market)) == 0);
        assert(tijori.paymentRemaining(address(0xBEEF)) <= 10 * U);
        assert(vault.balanceOf(address(yt)) >= pt.totalSupply() * yt.INDEX_UNIT() / yt.pyIndexCurrent());
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SeriesRegistry} from "./SeriesRegistry.sol";
import {YieldToken, ISeriesEntryPolicy} from "./YieldToken.sol";

/// @notice Creates the registry, then is the only source of series it will accept.
/// @dev Every series is this contract's own YieldToken bytecode over one vault fixed at deployment.
/// A stolen owner key can therefore open or pause maturities, but cannot list foreign code or a
/// foreign vault. No upgrades and no custody.
contract SeriesFactory {
    uint24 public constant POOL_FEE = 500;
    int24 public constant TICK_SPACING = 10;

    SeriesRegistry public immutable registry;
    IERC4626 public immutable vault;
    mapping(address => bool) public isSeries;

    error UnsupportedChain(uint256 chainId);
    error InvalidVault();
    error InvalidExpiry();
    error OnlyOwner();

    event SeriesCreated(uint256 indexed seriesId, address indexed yieldToken, address indexed principalToken, uint256 expiry);

    constructor(IERC20 asset, address owner, IERC4626 vault_) {
        if (block.chainid != 5042 && block.chainid != 5042002 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        if (address(vault_).code.length == 0 || vault_.asset() != address(asset)) revert InvalidVault();
        vault = vault_;
        registry = new SeriesRegistry(asset, owner, address(this));
    }

    /// @notice Deploy a maturity, register it and attach its static-fee, hook-free PT/USDC pool key.
    function create(uint256 expiry, string calldata label) external returns (uint256 seriesId, YieldToken yieldToken) {
        if (msg.sender != registry.owner()) revert OnlyOwner();
        // Entries close MIN_ENTRY_WINDOW before maturity; anything shorter could never be bought.
        if (expiry <= block.timestamp + registry.MIN_ENTRY_WINDOW()) revert InvalidExpiry();
        yieldToken = new YieldToken(vault, expiry, label, ISeriesEntryPolicy(address(registry)));
        isSeries[address(yieldToken)] = true;
        seriesId = registry.registerSeries(yieldToken);
        address pt = address(yieldToken.principalToken());
        address asset = address(registry.assetToken());
        (address currency0, address currency1) = pt < asset ? (pt, asset) : (asset, pt);
        registry.setPoolKey(seriesId, SeriesRegistry.PoolKey(currency0, currency1, POOL_FEE, TICK_SPACING, address(0)));
        emit SeriesCreated(seriesId, address(yieldToken), pt, expiry);
    }
}

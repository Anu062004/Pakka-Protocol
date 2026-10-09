// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {YieldToken} from "./YieldToken.sol";
import {PrincipalToken} from "./PrincipalToken.sol";

/// @notice Append-only directory of approved Pakka USDC series.
/// @dev The owner approves contract code; getter validation alone is not a code audit.
contract SeriesRegistry {
    // Same ABI field types/order as a Uniswap v4 PoolKey, without a new dependency.
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct Series {
        address vault;
        address principalToken;
        address yieldToken;
        uint256 expiry;
        bool hasPool;
        PoolKey poolKey;
    }

    /// @notice Entries close this long before maturity. A purchase minutes from expiry earns
    /// almost nothing and makes the annualized rate meaningless. Exits are never affected.
    uint256 public constant MIN_ENTRY_WINDOW = 1 hours;
    IERC20 public immutable assetToken;
    address public immutable owner;
    bool public entriesPaused;
    mapping(uint256 => bool) public seriesEntriesPaused;
    Series[] private _series;
    mapping(address => uint256) public seriesIdByYieldToken;
    mapping(address => uint256) public seriesIdByPrincipalToken;
    mapping(bytes32 => uint256) private _seriesIdByVaultExpiry;

    error UnsupportedChain(uint256 chainId);
    error InvalidOwner();
    error InvalidAsset();
    error OnlyOwner();
    error InvalidSeries();
    error ExpiredSeries();
    error SeriesAlreadyRegistered();
    error VaultExpiryAlreadyRegistered();
    error UnknownSeries(uint256 seriesId);
    error PoolAlreadySet();
    error InvalidPoolKey();

    event SeriesRegistered(
        uint256 indexed seriesId, address indexed yieldToken, address indexed principalToken,
        address vault, uint256 expiry
    );
    event PoolKeySet(uint256 indexed seriesId, bytes32 indexed poolId, PoolKey poolKey);
    event EntriesPaused(bool paused);
    event SeriesEntriesPaused(uint256 indexed seriesId, bool paused);

    constructor(IERC20 asset_, address owner_) {
        if (block.chainid != 5042 && block.chainid != 5042002 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        if (owner_ == address(0)) revert InvalidOwner();
        if (address(asset_).code.length == 0) revert InvalidAsset();
        if (IERC20Metadata(address(asset_)).decimals() != 6) revert InvalidAsset();
        if (block.chainid != 31337 && address(asset_) != 0x3600000000000000000000000000000000000000) revert InvalidAsset();
        assetToken = asset_;
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    /// @notice IDs start at 1; zero in reverse lookups means unregistered.
    function registerSeries(YieldToken yieldToken) external onlyOwner returns (uint256 seriesId) {
        address yt = address(yieldToken);
        if (yt.code.length == 0) revert InvalidSeries();
        if (seriesIdByYieldToken[yt] != 0 || seriesIdByPrincipalToken[yt] != 0) revert SeriesAlreadyRegistered();

        IERC4626 vault = yieldToken.vault();
        PrincipalToken pt = yieldToken.principalToken();
        uint256 expiry = yieldToken.expiry();
        if (address(vault).code.length == 0 || address(pt).code.length == 0) revert InvalidSeries();
        if (yt == address(pt) || yt == address(vault) || address(pt) == address(vault)) revert InvalidSeries();
        if (address(yieldToken.assetToken()) != address(assetToken) || vault.asset() != address(assetToken)) revert InvalidAsset();
        if (address(yieldToken.entryPolicy()) != address(this)) revert InvalidSeries();
        if (pt.yieldToken() != yt || pt.decimals() != 6 || yieldToken.decimals() != 6) revert InvalidSeries();
        if (expiry <= block.timestamp) revert ExpiredSeries();
        if (seriesIdByPrincipalToken[address(pt)] != 0 || seriesIdByYieldToken[address(pt)] != 0) revert SeriesAlreadyRegistered();

        bytes32 key = keccak256(abi.encode(address(vault), expiry));
        if (_seriesIdByVaultExpiry[key] != 0) revert VaultExpiryAlreadyRegistered();

        _series.push();
        seriesId = _series.length;
        Series storage item = _series[seriesId - 1];
        item.vault = address(vault);
        item.principalToken = address(pt);
        item.yieldToken = yt;
        item.expiry = expiry;
        seriesIdByYieldToken[yt] = seriesId;
        seriesIdByPrincipalToken[address(pt)] = seriesId;
        _seriesIdByVaultExpiry[key] = seriesId;
        emit SeriesRegistered(seriesId, yt, address(pt), address(vault), expiry);
    }

    /// @notice Attach a static-fee, hook-free PT/USDC pool key once before maturity.
    /// @dev Records metadata only. The owner must verify pool creation and liquidity.
    /// Custom hooks/dynamic fees belong to the later market phase of the specification.
    function setPoolKey(uint256 seriesId, PoolKey calldata key) external onlyOwner {
        Series storage item = _getSeries(seriesId);
        if (item.hasPool) revert PoolAlreadySet();
        if (item.expiry <= block.timestamp) revert ExpiredSeries();
        address pt = item.principalToken;
        address asset = address(assetToken);
        (address currency0, address currency1) = pt < asset ? (pt, asset) : (asset, pt);
        if (key.currency0 != currency0 || key.currency1 != currency1) revert InvalidPoolKey();
        if (key.fee > 1_000_000 || key.tickSpacing < 1 || key.tickSpacing > 32_767 || key.hooks != address(0)) revert InvalidPoolKey();
        item.poolKey = key;
        item.hasPool = true;
        emit PoolKeySet(seriesId, keccak256(abi.encode(key)), key);
    }

    function seriesCount() external view returns (uint256) {
        return _series.length;
    }

    function setEntriesPaused(bool paused_) external onlyOwner {
        entriesPaused = paused_;
        emit EntriesPaused(paused_);
    }

    function setSeriesEntriesPaused(uint256 id, bool paused_) external onlyOwner {
        _getSeries(id);
        seriesEntriesPaused[id] = paused_;
        emit SeriesEntriesPaused(id, paused_);
    }

    function entryOpen(address yt) external view returns (bool) {
        uint256 id = seriesIdByYieldToken[yt];
        return id != 0 && !entriesPaused && !seriesEntriesPaused[id] &&
            block.timestamp + MIN_ENTRY_WINDOW < _series[id - 1].expiry;
    }

    function isHandledToken(address token) external view returns (bool) {
        return token == address(assetToken) || seriesIdByPrincipalToken[token] != 0 || seriesIdByYieldToken[token] != 0;
    }

    function getSeries(uint256 seriesId) external view returns (Series memory) {
        return _getSeries(seriesId);
    }

    function seriesIdFor(address vault, uint256 expiry) external view returns (uint256) {
        return _seriesIdByVaultExpiry[keccak256(abi.encode(vault, expiry))];
    }

    function _getSeries(uint256 seriesId) private view returns (Series storage) {
        if (seriesId == 0 || seriesId > _series.length) revert UnknownSeries(seriesId);
        return _series[seriesId - 1];
    }
}

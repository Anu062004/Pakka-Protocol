// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PrincipalToken} from "./PrincipalToken.sol";

interface ISeriesEntryPolicy {
    function assetToken() external view returns (IERC20);
    function entryOpen(address yieldToken) external view returns (bool);
}

/// @notice Pakka core: split ERC-4626 shares into principal and yield.
/// @dev No admin, upgrade, fee, oracle or third-party withdrawal path.
contract YieldToken is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC4626 public immutable vault;
    IERC20 public immutable assetToken;
    PrincipalToken public immutable principalToken;
    uint256 public immutable expiry;
    uint256 public immutable INDEX_UNIT;
    uint8 private immutable _assetDecimals;
    ISeriesEntryPolicy public immutable entryPolicy;
    uint256 public constant SERIES_TVL_CAP = 500_000_000;
    uint256 public constant MAX_INDEX_CHANGE_BPS = 100;
    /// @notice The accepted band widens by this much per day since the last accepted observation.
    /// Ordinary vault growth therefore never trips the guard, however long a series sits idle,
    /// and a real, persistent move is eventually accepted instead of freezing the series for good.
    uint256 public constant INDEX_DRIFT_BPS_PER_DAY = 25;
    uint256 public lastSafeVaultIndex;
    uint256 public lastSafeTimestamp;
    uint256 public indexReference;
    uint256 public indexReferenceBlock;
    uint256 public indexReferenceTimestamp;

    uint256 public pyIndexStored;
    uint256 public indexAtExpiry;
    uint256 public totalAccruedInterest;
    mapping(address => uint256) public userIndex;
    mapping(address => uint256) public interestShares;

    error UnsupportedChain(uint256 chainId);
    error InvalidVault();
    error InvalidExpiry();
    error InvalidReceiver();
    error InvalidAmount();
    error UnsupportedShareDecimals();
    error ZeroIndex();
    error SeriesExpired();
    error SeriesNotExpired();
    error SeriesInactive();
    error SeriesCapExceeded();
    error VaultDepositLimit(uint256 requested, uint256 available);
    error VaultRedeemLimit(uint256 requested, uint256 available);
    error IndexCircuitBreaker();
    error UnexpectedTransferAmount();

    event Split(address indexed caller, address indexed receiver, uint256 shares, uint256 amount);
    event Merge(address indexed caller, address indexed receiver, uint256 amount, uint256 shares, uint256 output, bool toAssets);
    event PrincipalRedeemed(address indexed caller, address indexed receiver, uint256 amount, uint256 shares, uint256 output, bool toAssets);
    event InterestClaimed(address indexed user, uint256 shares, uint256 output, bool toAssets);
    event ExpirySettled(uint256 indexed expiry, uint256 index, uint256 settledAt);

    constructor(IERC4626 vault_, uint256 expiry_, string memory label, ISeriesEntryPolicy policy_) ERC20(
        string.concat("Pakka Yield ", label), string.concat("YT-", label)
    ) {
        // Restricted to Arc mainnet, Arc Testnet and local Hardhat/Anvil.
        if (block.chainid != 5042 && block.chainid != 5042002 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        if (address(vault_).code.length == 0) revert InvalidVault();
        if (expiry_ <= block.timestamp) revert InvalidExpiry();
        uint8 shareDecimals = vault_.decimals();
        if (shareDecimals > 59) revert UnsupportedShareDecimals();
        vault = vault_;
        expiry = expiry_;
        INDEX_UNIT = 10 ** (uint256(shareDecimals) + 18);
        address asset = vault_.asset();
        if (asset.code.length == 0) revert InvalidVault();
        if (block.chainid != 31337 && asset != 0x3600000000000000000000000000000000000000) revert InvalidVault();
        assetToken = IERC20(asset);
        _assetDecimals = IERC20Metadata(asset).decimals();
        // Zero policy is reserved for isolated local arithmetic fixtures, never registered series.
        if (address(policy_) == address(0)) {
            if (block.chainid != 31337) revert InvalidVault();
        } else if (address(policy_).code.length == 0 || address(policy_.assetToken()) != asset || _assetDecimals != 6) {
            revert InvalidVault();
        }
        entryPolicy = policy_;
        principalToken = new PrincipalToken(label, _assetDecimals);
        pyIndexStored = vault_.convertToAssets(INDEX_UNIT);
        if (pyIndexStored == 0) revert ZeroIndex();
        lastSafeVaultIndex = pyIndexStored;
        lastSafeTimestamp = block.timestamp;
        indexReference = pyIndexStored;
        indexReferenceBlock = block.number;
        indexReferenceTimestamp = block.timestamp;
    }

    function decimals() public view override returns (uint8) {
        return _assetDecimals;
    }

    /// @notice The current high-water mark, including an uncheckpointed vault gain.
    function pyIndexCurrent() public view returns (uint256) {
        uint256 live = vault.convertToAssets(INDEX_UNIT);
        return _indexHealthy(live) ? Math.max(pyIndexStored, live) : pyIndexStored;
    }

    function indexHealthy() public view returns (bool) {
        return _indexHealthy(vault.convertToAssets(INDEX_UNIT));
    }

    function tvl() public view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(address(this)));
    }

    /// @notice Permissionless observation; an anomalous index never poisons the high-water mark.
    function checkpointIndex() external nonReentrant returns (uint256) { return _sync(); }

    /// @notice Frozen after settlement; before settlement reflects the current vault.
    function interestIndex() public view returns (uint256) {
        return indexAtExpiry == 0 ? pyIndexCurrent() : indexAtExpiry;
    }

    function previewSplit(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, pyIndexCurrent(), INDEX_UNIT);
    }

    /// @notice Share requirement rounded up. Actual payouts always round down.
    function sharesForPT(uint256 amount) public view returns (uint256) {
        return Math.mulDiv(amount, INDEX_UNIT, interestIndex(), Math.Rounding.Ceil);
    }

    function accruedInterest(address user) public view returns (uint256) {
        return interestShares[user] + _interest(balanceOf(user), userIndex[user], interestIndex());
    }

    function split(uint256 shares, address receiver) external nonReentrant returns (uint256 amount) {
        _validateSplit(shares, receiver);
        _checkCapacity(vault.convertToAssets(shares));
        IERC20(address(vault)).safeTransferFrom(msg.sender, address(this), shares);
        amount = _split(shares, receiver);
    }

    function splitFromAssets(uint256 assets, address receiver) external nonReentrant returns (uint256 amount) {
        _validateSplit(assets, receiver);
        _checkCapacity(assets);
        uint256 available = vault.maxDeposit(address(this));
        if (assets > available) revert VaultDepositLimit(assets, available);
        uint256 beforeBalance = assetToken.balanceOf(address(this));
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        if (assetToken.balanceOf(address(this)) - beforeBalance != assets) revert UnexpectedTransferAmount();
        assetToken.forceApprove(address(vault), assets);
        uint256 shares = vault.deposit(assets, address(this));
        assetToken.forceApprove(address(vault), 0);
        amount = _split(shares, receiver);
    }

    function merge(uint256 amount, address receiver, bool toAssets) external nonReentrant returns (uint256 output) {
        if (block.timestamp >= expiry) revert SeriesExpired();
        _validatePayout(amount, receiver);
        uint256 index = _sync();
        uint256 shares = Math.mulDiv(amount, INDEX_UNIT, index);
        principalToken.burn(msg.sender, amount);
        _burn(msg.sender, amount); // Settles the owner's yield before reducing balance.
        output = _pay(shares, receiver, toAssets);
        emit Merge(msg.sender, receiver, amount, shares, output, toAssets);
    }

    function redeemPT(uint256 amount, address receiver, bool toAssets) external nonReentrant returns (uint256 output) {
        if (block.timestamp < expiry) revert SeriesNotExpired();
        _validatePayout(amount, receiver);
        _sync();
        uint256 shares = Math.mulDiv(amount, INDEX_UNIT, indexAtExpiry);
        principalToken.burn(msg.sender, amount);
        output = _pay(shares, receiver, toAssets);
        emit PrincipalRedeemed(msg.sender, receiver, amount, shares, output, toAssets);
    }

    /// @notice Permissionless trigger; pays only the specified user's own address.
    function claimInterest(address user, bool toAssets) external nonReentrant returns (uint256 output) {
        if (user == address(0) || user == address(this)) revert InvalidReceiver();
        _settleUser(user, _sync());
        uint256 shares = interestShares[user];
        interestShares[user] = 0;
        totalAccruedInterest -= shares;
        output = _pay(shares, user, toAssets);
        emit InterestClaimed(user, shares, output, toAssets);
    }

    /// @dev ERC-4626 has no historical index API. A keeper should call at expiry.
    /// Late lazy settlement includes growth up to the first interaction after expiry.
    function settleExpiry() external nonReentrant returns (uint256) {
        if (block.timestamp < expiry) revert SeriesNotExpired();
        return _sync();
    }

    function transfer(address to, uint256 value) public override nonReentrant returns (bool) {
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override nonReentrant returns (bool) {
        return super.transferFrom(from, to, value);
    }

    function _split(uint256 shares, address receiver) private returns (uint256 amount) {
        amount = Math.mulDiv(shares, _sync(), INDEX_UNIT);
        if (amount == 0) revert InvalidAmount();
        if (address(entryPolicy) != address(0) && tvl() > SERIES_TVL_CAP) revert SeriesCapExceeded();
        principalToken.mint(receiver, amount);
        _mint(receiver, amount); // Settles the receiver before minting new yield rights.
        emit Split(msg.sender, receiver, shares, amount);
    }

    function _validateSplit(uint256 amount, address receiver) private view {
        if (block.timestamp >= expiry) revert SeriesExpired();
        if (address(entryPolicy) != address(0)) {
            if (!entryPolicy.entryOpen(address(this))) revert SeriesInactive();
            if (!indexHealthy()) revert IndexCircuitBreaker();
        }
        _validatePayout(amount, receiver);
    }

    function _checkCapacity(uint256 incoming) private view {
        if (address(entryPolicy) != address(0)) {
            uint256 current = tvl();
            if (current > SERIES_TVL_CAP || incoming > SERIES_TVL_CAP - current) revert SeriesCapExceeded();
        }
    }

    function _indexHealthy(uint256 live) private view returns (bool) {
        if (address(entryPolicy) == address(0)) return true;
        // Within one block the band is measured from the pre-block anchor, so repeated
        // checkpoints cannot ratchet the index past a single observation's bound.
        bool sameBlock = indexReferenceBlock == block.number;
        uint256 anchor = sameBlock ? indexReference : lastSafeVaultIndex;
        uint256 since = sameBlock ? indexReferenceTimestamp : lastSafeTimestamp;
        // Saturating: a simulated call may run with an earlier clock than the last mined block.
        uint256 elapsed = block.timestamp > since ? block.timestamp - since : 0;
        uint256 deviation = Math.mulDiv(anchor,
            MAX_INDEX_CHANGE_BPS + INDEX_DRIFT_BPS_PER_DAY * elapsed / 1 days, 10_000);
        return live != 0 && (live >= anchor ? live - anchor <= deviation : anchor - live <= deviation);
    }

    function _validatePayout(uint256 amount, address receiver) private view {
        if (amount == 0) revert InvalidAmount();
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver();
    }

    function _sync() private returns (uint256 index) {
        // Stop consulting the live vault after expiry is frozen. Share exits remain
        // usable even if the vault's conversion/redeem interface later fails.
        if (indexAtExpiry != 0) return indexAtExpiry;
        uint256 live = vault.convertToAssets(INDEX_UNIT);
        if (_indexHealthy(live)) {
            if (indexReferenceBlock != block.number) {
                indexReference = lastSafeVaultIndex;
                indexReferenceBlock = block.number;
                indexReferenceTimestamp = lastSafeTimestamp;
            }
            lastSafeVaultIndex = live;
            lastSafeTimestamp = block.timestamp;
            index = Math.max(pyIndexStored, live);
        } else {
            // Entry checks revert; exits use the last accepted index and remain unpaused.
            index = pyIndexStored;
        }
        pyIndexStored = index;
        if (block.timestamp >= expiry) {
            indexAtExpiry = index;
            emit ExpirySettled(expiry, index, block.timestamp);
        }
    }

    function _update(address from, address to, uint256 value) internal override {
        uint256 index = _sync();
        if (from != address(0)) _settleUser(from, index);
        if (to != address(0) && to != from) _settleUser(to, index);
        super._update(from, to, value);
    }

    function _settleUser(address user, uint256 index) private {
        uint256 earned = _interest(balanceOf(user), userIndex[user], index);
        interestShares[user] += earned;
        totalAccruedInterest += earned;
        userIndex[user] = index;
    }

    /// @dev Exactly floor(balance * INDEX_UNIT * (current - previous) / (previous * current)).
    /// Quotient/remainder decomposition avoids overflowing the three-factor numerator
    /// or the index product, while preserving the specification's single rounding.
    function _interest(uint256 balance, uint256 previous, uint256 current) internal view returns (uint256) {
        if (balance == 0 || previous == 0 || current <= previous) return 0;
        uint256 delta = current - previous;
        uint256 backing = Math.mulDiv(balance, INDEX_UNIT, previous);
        uint256 earned = Math.mulDiv(backing, delta, current);
        uint256 residual = Math.mulDiv(mulmod(balance, INDEX_UNIT, previous), delta, previous);
        if (residual >= current - mulmod(backing, delta, current)) ++earned;
        return earned;
    }

    function _pay(uint256 shares, address receiver, bool toAssets) private returns (uint256) {
        if (shares == 0) return 0;
        if (toAssets) {
            uint256 available = vault.maxRedeem(address(this));
            if (shares > available) revert VaultRedeemLimit(shares, available);
            return vault.redeem(shares, receiver, address(this));
        }
        IERC20(address(vault)).safeTransfer(receiver, shares);
        return shares;
    }
}

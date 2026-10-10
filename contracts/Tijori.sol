// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PakkaRouter} from "./PakkaRouter.sol";
import {SeriesRegistry} from "./SeriesRegistry.sol";
import {YieldToken} from "./YieldToken.sol";

/// @notice Owner-controlled treasury with one restricted agent.
/// @dev Clones share immutable trusted dependencies; all positions/proceeds stay in the clone.
contract Tijori is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct PayeeLimit {
        uint256 cap;
        uint256 spent;
        uint256 window;
    }

    uint256 public constant PAYEE_PERIOD = 30 days;
    uint256 public constant MAX_ACTIVE_PAYMENTS = 128;
    PakkaRouter public immutable router;
    SeriesRegistry public immutable registry;
    IERC20 public immutable assetToken;
    address public immutable factory;

    address public owner;
    address public agent;
    bool public paused;
    bool public initialized;
    uint256 public dailyCap;
    /// @dev USDC paid per clock hour. The cap is measured over the current hour and the 24 before
    /// it, a window of 24 to 25 hours, so no 24-hour period can exceed it at any boundary.
    mapping(uint256 => uint256) private _hourlySpent;
    mapping(address => PayeeLimit) public payeeLimits;
    struct Payment { uint64 timestamp; uint192 amount; }
    mapping(address => Payment[]) private _payments;
    mapping(address => uint256) private _paymentHead;

    error UnsupportedChain(uint256 chainId);
    error InvalidConfiguration();
    error AlreadyInitialized();
    error Unauthorized();
    error AgentPaused();
    error InvalidAmount();
    error InvalidPayee();
    error PaymentCapExceeded();
    error PurchaseCapExceeded();
    error UnexpectedTransferAmount();
    error SlippageExceeded();
    error UnsupportedToken();
    error PayeeBlacklisted();
    error TreasuryBlacklisted();
    error PaymentFailed();
    error PayeeHistoryFull();

    event Initialized(address indexed owner, address indexed agent, uint256 dailyCap);
    event AgentChanged(address indexed previousAgent, address indexed newAgent);
    event PauseChanged(bool paused);
    event DailyCapChanged(uint256 cap);
    event PayeeCapChanged(address indexed payee, uint256 cap);
    event Deposited(address indexed owner, uint256 amount);
    event Withdrawn(address indexed token, address indexed owner, uint256 amount);
    event Paid(address indexed caller, address indexed payee, uint256 amount);
    event InterestClaimed(uint256 indexed seriesId, uint256 output, bool toAssets);

    constructor(PakkaRouter router_) {
        if (block.chainid != 5042 && block.chainid != 5042002 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        if (address(router_).code.length == 0) revert InvalidConfiguration();
        router = router_;
        registry = router_.registry();
        assetToken = router_.assetToken();
        factory = msg.sender;
        // Constructor storage is not copied into clones. Lock the implementation itself.
        initialized = true;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != owner) {
            if (msg.sender != agent) revert Unauthorized();
            if (paused) revert AgentPaused();
        }
        _;
    }

    function initialize(address owner_, address agent_, uint256 dailyCap_) external {
        if (initialized) revert AlreadyInitialized();
        if (block.chainid != 5042 && block.chainid != 5042002 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        if (msg.sender != factory) revert Unauthorized();
        if (owner_ == address(0)) revert InvalidConfiguration();
        initialized = true;
        owner = owner_;
        agent = agent_; // Zero disables the agent. Smart-account agents are allowed.
        dailyCap = dailyCap_;
        emit Initialized(owner_, agent_, dailyCap_);
    }

    function setAgent(address agent_) external nonReentrant onlyOwner {
        emit AgentChanged(agent, agent_);
        agent = agent_;
    }

    function setPaused(bool paused_) external nonReentrant onlyOwner {
        paused = paused_;
        emit PauseChanged(paused_);
    }

    function setDailyCap(uint256 cap) external nonReentrant onlyOwner {
        dailyCap = cap;
        emit DailyCapChanged(cap);
    }

    /// @notice Set a payee's exact rolling 30-day cap. Zero revokes approval.
    /// Updating/revoking/reapproving a cap never erases spending in the current window.
    function setPayeeCap(address payee, uint256 cap) external nonReentrant onlyOwner {
        if (payee == address(0) || payee == address(this)) revert InvalidPayee();
        payeeLimits[payee].cap = cap;
        emit PayeeCapChanged(payee, cap);
    }

    function deposit(uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert InvalidAmount();
        uint256 beforeBalance = assetToken.balanceOf(address(this));
        assetToken.safeTransferFrom(msg.sender, address(this), amount);
        if (assetToken.balanceOf(address(this)) - beforeBalance != amount) revert UnexpectedTransferAmount();
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw USDC or registered PT/YT to the owner, even while paused.
    function withdraw(IERC20 token, uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert InvalidAmount();
        if (!registry.isHandledToken(address(token))) revert UnsupportedToken();
        token.safeTransfer(owner, amount);
        emit Withdrawn(address(token), owner, amount);
    }

    /// @notice Payments counted against the daily cap right now.
    function dailySpent() public view returns (uint256 spent) {
        uint256 hour = block.timestamp / 1 hours;
        for (uint256 i; i <= 24 && i <= hour; ++i) spent += _hourlySpent[hour - i];
    }

    /// @notice Current payment allowance, excluding available USDC balance.
    function paymentRemaining(address payee) public view returns (uint256) {
        PayeeLimit memory limit = payeeLimits[payee];
        uint256 payeeSpent;
        Payment[] storage history = _payments[payee];
        for (uint256 i = _paymentHead[payee]; i < history.length; ++i) {
            if (uint256(history[i].timestamp) + PAYEE_PERIOD > block.timestamp) payeeSpent += history[i].amount;
        }
        uint256 daySpent = dailySpent();
        return Math.min(limit.cap > payeeSpent ? limit.cap - payeeSpent : 0,
            dailyCap > daySpent ? dailyCap - daySpent : 0);
    }

    /// @notice Both owner and agent payments obey caps; owner withdrawals are independent.
    function pay(address payee, uint256 amount) external nonReentrant onlyOperator {
        if (amount == 0) revert InvalidAmount();
        if (amount > type(uint192).max) revert InvalidAmount();
        if (_blacklisted(payee)) revert PayeeBlacklisted();
        if (_blacklisted(address(this))) revert TreasuryBlacklisted();
        if (amount > paymentRemaining(payee)) revert PaymentCapExceeded();
        PayeeLimit storage limit = payeeLimits[payee];
        Payment[] storage history = _payments[payee];
        uint256 head = _paymentHead[payee];
        while (head < history.length && uint256(history[head].timestamp) + PAYEE_PERIOD <= block.timestamp) {
            limit.spent -= history[head].amount;
            ++head;
        }
        _paymentHead[payee] = head;
        limit.window = block.timestamp;
        _hourlySpent[block.timestamp / 1 hours] += amount;
        limit.spent += amount;
        if (history.length > head && history[history.length - 1].timestamp == block.timestamp) {
            uint256 combined = uint256(history[history.length - 1].amount) + amount;
            if (combined > type(uint192).max) revert InvalidAmount();
            history[history.length - 1].amount = uint192(combined);
        } else {
            // ponytail: bounded exact rolling history; raise throughput only after gas review.
            if (history.length - head >= MAX_ACTIVE_PAYMENTS) revert PayeeHistoryFull();
            history.push(Payment(uint64(block.timestamp), uint192(amount)));
        }
        // Per-payee queues preserve an exact sliding window across calendar boundaries.
        (bool success, bytes memory result) = address(assetToken).call(
            abi.encodeCall(IERC20.transfer, (payee, amount)));
        if (!success || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) revert PaymentFailed();
        emit Paid(msg.sender, payee, amount);
    }

    function lock(uint256 seriesId, uint256 ptAmount, uint256 maxUsdc, uint256 deadline)
        external nonReentrant onlyOperator returns (uint256 usdcSpent)
    {
        _purchaseCap(ptAmount, maxUsdc);
        assetToken.forceApprove(address(router), maxUsdc);
        usdcSpent = router.lock(seriesId, ptAmount, maxUsdc, address(this), deadline);
        assetToken.forceApprove(address(router), 0);
    }

    function buildLadder(PakkaRouter.LadderLeg[] calldata legs, uint256 maxTotalUsdc, uint256 deadline)
        external nonReentrant onlyOperator returns (uint256 usdcSpent)
    {
        for (uint256 i; i < legs.length; ++i) _purchaseCap(legs[i].ptAmount, legs[i].maxUsdc);
        assetToken.forceApprove(address(router), maxTotalUsdc);
        usdcSpent = router.buildLadder(legs, maxTotalUsdc, address(this), deadline);
        assetToken.forceApprove(address(router), 0);
    }

    function cashOut(uint256 seriesId, uint256 ptAmount, bool toAssets, uint256 minOutput, uint256 deadline)
        external nonReentrant onlyOperator returns (uint256 output)
    {
        IERC20 pt = IERC20(registry.getSeries(seriesId).principalToken);
        pt.forceApprove(address(router), ptAmount);
        output = router.cashOut(seriesId, ptAmount, address(this), toAssets, minOutput, deadline);
        pt.forceApprove(address(router), 0);
    }

    function claimInterest(uint256 seriesId, bool toAssets, uint256 minOutput)
        external nonReentrant onlyOperator returns (uint256 output)
    {
        YieldToken yt = YieldToken(registry.getSeries(seriesId).yieldToken);
        output = yt.claimInterest(address(this), toAssets);
        if (output < minOutput) revert SlippageExceeded();
        emit InterestClaimed(seriesId, output, toAssets);
    }

    function _purchaseCap(uint256 ptAmount, uint256 maxUsdc) private pure {
        if (ptAmount == 0 || maxUsdc == 0) revert InvalidAmount();
        // PT and USDC share 6 decimals. Limit the total fee-inclusive price to face value.
        if (maxUsdc > ptAmount) revert PurchaseCapExceeded();
    }

    function _blacklisted(address account) private view returns (bool) {
        (bool ok, bytes memory result) = address(assetToken).staticcall(abi.encodeWithSignature("isBlacklisted(address)", account));
        return ok && result.length == 32 && abi.decode(result, (bool));
    }

    /// @notice Recover only the registered vault shares retained by an explicit share exit.
    function withdrawVaultShares(uint256 seriesId, uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert InvalidAmount();
        IERC20 shares = IERC20(registry.getSeries(seriesId).vault);
        shares.safeTransfer(owner, amount);
        emit Withdrawn(address(shares), owner, amount);
    }
}

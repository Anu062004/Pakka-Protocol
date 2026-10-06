// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UniswapV4Market} from "../UniswapV4Market.sol";

/// @dev Pre-funded local fixture to exercise two v4 unlocks in one transaction.
/// This is not the production router or a treasury contract.
contract V4BatchHarness {
    using SafeERC20 for IERC20;

    function buyTwice(UniswapV4Market market, uint256 id, uint256 amount, uint256 firstMax,
        uint256 secondMax, address receiver, uint256 deadline) external returns (uint256 spent)
    {
        IERC20 asset = market.registry().assetToken();
        asset.forceApprove(address(market), firstMax + secondMax);
        spent = market.buyPT(id, amount, firstMax, receiver, deadline);
        spent += market.buyPT(id, amount, secondMax, receiver, deadline);
        asset.forceApprove(address(market), 0);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {PrincipalToken} from "../PrincipalToken.sol";

/// @dev Negative registry tests only. Lets tests supply inconsistent metadata.
contract MockSeries {
    IERC4626 public immutable vault;
    IERC20 public immutable assetToken;
    uint256 public immutable expiry;
    uint8 public immutable decimals;
    PrincipalToken public principalToken;

    constructor(IERC4626 vault_, IERC20 asset_, uint256 expiry_, uint8 decimals_) {
        vault = vault_;
        assetToken = asset_;
        expiry = expiry_;
        decimals = decimals_;
        principalToken = new PrincipalToken("MOCK", decimals_);
    }

    function setPrincipalToken(PrincipalToken pt) external {
        principalToken = pt;
    }
    function entryPolicy() external view returns (address) { return msg.sender; }
}

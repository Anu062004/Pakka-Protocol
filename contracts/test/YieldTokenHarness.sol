// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {YieldToken, ISeriesEntryPolicy} from "../YieldToken.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

contract YieldTokenHarness is YieldToken {
    constructor(IERC4626 vault_, uint256 expiry_) YieldToken(vault_, expiry_, "TEST", ISeriesEntryPolicy(address(0))) {}
    function interestFor(uint256 balance, uint256 previous, uint256 current) external view returns (uint256) {
        return _interest(balance, previous, current);
    }
}

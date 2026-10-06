// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MockUSDC} from "./MockUSDC.sol";

/// @dev Local fixture: attempt reentry or short-credit a router deposit. Never deploy as real USDC.
contract AdversarialUSDC is MockUSDC {
    address public target;
    bytes public attackData;
    bool public tax;
    bool public reentryBlocked;

    function configure(address target_, bytes calldata data_, bool tax_) external {
        target = target_;
        attackData = data_;
        tax = tax_;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (to == target && attackData.length != 0) {
            (bool success, bytes memory reason) = target.call(attackData);
            reentryBlocked = !success && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()"));
        }
        bool result = super.transferFrom(from, to, value);
        if (tax && to == target && value != 0) _burn(to, 1);
        return result;
    }
}

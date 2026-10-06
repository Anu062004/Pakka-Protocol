// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (proxy/Clones.sol)
pragma solidity ^0.8.20;

import {Errors} from "../utils/Errors.sol";

/// @dev ERC-1167 minimal proxies. Upstream v5.1.0; comments/formatting normalized.
library Clones {
    function clone(address implementation) internal returns (address instance) {
        return clone(implementation, 0);
    }

    function clone(address implementation, uint256 value) internal returns (address instance) {
        if (address(this).balance < value) {
            revert Errors.InsufficientBalance(address(this).balance, value);
        }
        assembly ("memory-safe") {
            mstore(0x00, or(shr(0xe8, shl(0x60, implementation)), 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000))
            mstore(0x20, or(shl(0x78, implementation), 0x5af43d82803e903d91602b57fd5bf3))
            instance := create(value, 0x09, 0x37)
        }
        if (instance == address(0)) revert Errors.FailedDeployment();
    }

    function cloneDeterministic(address implementation, bytes32 salt) internal returns (address instance) {
        return cloneDeterministic(implementation, salt, 0);
    }

    function cloneDeterministic(address implementation, bytes32 salt, uint256 value)
        internal returns (address instance)
    {
        if (address(this).balance < value) {
            revert Errors.InsufficientBalance(address(this).balance, value);
        }
        assembly ("memory-safe") {
            mstore(0x00, or(shr(0xe8, shl(0x60, implementation)), 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000))
            mstore(0x20, or(shl(0x78, implementation), 0x5af43d82803e903d91602b57fd5bf3))
            instance := create2(value, 0x09, 0x37, salt)
        }
        if (instance == address(0)) revert Errors.FailedDeployment();
    }

    function predictDeterministicAddress(address implementation, bytes32 salt, address deployer)
        internal pure returns (address predicted)
    {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(add(ptr, 0x38), deployer)
            mstore(add(ptr, 0x24), 0x5af43d82803e903d91602b57fd5bf3ff)
            mstore(add(ptr, 0x14), implementation)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73)
            mstore(add(ptr, 0x58), salt)
            mstore(add(ptr, 0x78), keccak256(add(ptr, 0x0c), 0x37))
            predicted := and(keccak256(add(ptr, 0x43), 0x55), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }

    function predictDeterministicAddress(address implementation, bytes32 salt)
        internal view returns (address predicted)
    {
        return predictDeterministicAddress(implementation, salt, address(this));
    }
}

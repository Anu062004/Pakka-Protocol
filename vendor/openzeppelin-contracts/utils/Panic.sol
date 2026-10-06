// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v5.1.0; documentation comments omitted.
pragma solidity ^0.8.20;
library Panic {
 uint256 internal constant GENERIC = 0x00;
 uint256 internal constant ASSERT = 0x01;
 uint256 internal constant UNDER_OVERFLOW = 0x11;
 uint256 internal constant DIVISION_BY_ZERO = 0x12;
 uint256 internal constant ENUM_CONVERSION_ERROR = 0x21;
 uint256 internal constant STORAGE_ENCODING_ERROR = 0x22;
 uint256 internal constant EMPTY_ARRAY_POP = 0x31;
 uint256 internal constant ARRAY_OUT_OF_BOUNDS = 0x32;
 uint256 internal constant RESOURCE_ERROR = 0x41;
 uint256 internal constant INVALID_INTERNAL_FUNCTION = 0x51;
 function panic(uint256 code) internal pure {
  assembly ("memory-safe") {
   mstore(0x00, 0x4e487b71)
   mstore(0x20, code)
   revert(0x1c, 0x24)
  }
 }
}

// SPDX-License-Identifier: MIT
// OpenZeppelin source with documentation comments omitted
pragma solidity ^0.8.20;
 library SafeCast {
 error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value);
 error SafeCastOverflowedIntToUint(int256 value);
 error SafeCastOverflowedIntDowncast(uint8 bits, int256 value);
 error SafeCastOverflowedUintToInt(uint256 value);
 function toUint248(uint256 value) internal pure returns (uint248) {
if (value > type(uint248).max) {
revert SafeCastOverflowedUintDowncast(248, value);
}
return uint248(value);
}
 function toUint240(uint256 value) internal pure returns (uint240) {
if (value > type(uint240).max) {
revert SafeCastOverflowedUintDowncast(240, value);
}
return uint240(value);
}
 function toUint232(uint256 value) internal pure returns (uint232) {
if (value > type(uint232).max) {
revert SafeCastOverflowedUintDowncast(232, value);
}
return uint232(value);
}
 function toUint224(uint256 value) internal pure returns (uint224) {
if (value > type(uint224).max) {
revert SafeCastOverflowedUintDowncast(224, value);
}
return uint224(value);
}
 function toUint216(uint256 value) internal pure returns (uint216) {
if (value > type(uint216).max) {
revert SafeCastOverflowedUintDowncast(216, value);
}
return uint216(value);
}
 function toUint208(uint256 value) internal pure returns (uint208) {
if (value > type(uint208).max) {
revert SafeCastOverflowedUintDowncast(208, value);
}
return uint208(value);
}
 function toUint200(uint256 value) internal pure returns (uint200) {
if (value > type(uint200).max) {
revert SafeCastOverflowedUintDowncast(200, value);
}
return uint200(value);
}
 function toUint192(uint256 value) internal pure returns (uint192) {
if (value > type(uint192).max) {
revert SafeCastOverflowedUintDowncast(192, value);
}
return uint192(value);
}
 function toUint184(uint256 value) internal pure returns (uint184) {
if (value > type(uint184).max) {
revert SafeCastOverflowedUintDowncast(184, value);
}
return uint184(value);
}
 function toUint176(uint256 value) internal pure returns (uint176) {
if (value > type(uint176).max) {
revert SafeCastOverflowedUintDowncast(176, value);
}
return uint176(value);
}
 function toUint168(uint256 value) internal pure returns (uint168) {
if (value > type(uint168).max) {
revert SafeCastOverflowedUintDowncast(168, value);
}
return uint168(value);
}
 function toUint160(uint256 value) internal pure returns (uint160) {
if (value > type(uint160).max) {
revert SafeCastOverflowedUintDowncast(160, value);
}
return uint160(value);
}
 function toUint152(uint256 value) internal pure returns (uint152) {
if (value > type(uint152).max) {
revert SafeCastOverflowedUintDowncast(152, value);
}
return uint152(value);
}
 function toUint144(uint256 value) internal pure returns (uint144) {
if (value > type(uint144).max) {
revert SafeCastOverflowedUintDowncast(144, value);
}
return uint144(value);
}
 function toUint136(uint256 value) internal pure returns (uint136) {
if (value > type(uint136).max) {
revert SafeCastOverflowedUintDowncast(136, value);
}
return uint136(value);
}
 function toUint128(uint256 value) internal pure returns (uint128) {
if (value > type(uint128).max) {
revert SafeCastOverflowedUintDowncast(128, value);
}
return uint128(value);
}
 function toUint120(uint256 value) internal pure returns (uint120) {
if (value > type(uint120).max) {
revert SafeCastOverflowedUintDowncast(120, value);
}
return uint120(value);
}
 function toUint112(uint256 value) internal pure returns (uint112) {
if (value > type(uint112).max) {
revert SafeCastOverflowedUintDowncast(112, value);
}
return uint112(value);
}
 function toUint104(uint256 value) internal pure returns (uint104) {
if (value > type(uint104).max) {
revert SafeCastOverflowedUintDowncast(104, value);
}
return uint104(value);
}
 function toUint96(uint256 value) internal pure returns (uint96) {
if (value > type(uint96).max) {
revert SafeCastOverflowedUintDowncast(96, value);
}
return uint96(value);
}
 function toUint88(uint256 value) internal pure returns (uint88) {
if (value > type(uint88).max) {
revert SafeCastOverflowedUintDowncast(88, value);
}
return uint88(value);
}
 function toUint80(uint256 value) internal pure returns (uint80) {
if (value > type(uint80).max) {
revert SafeCastOverflowedUintDowncast(80, value);
}
return uint80(value);
}
 function toUint72(uint256 value) internal pure returns (uint72) {
if (value > type(uint72).max) {
revert SafeCastOverflowedUintDowncast(72, value);
}
return uint72(value);
}
 function toUint64(uint256 value) internal pure returns (uint64) {
if (value > type(uint64).max) {
revert SafeCastOverflowedUintDowncast(64, value);
}
return uint64(value);
}
 function toUint56(uint256 value) internal pure returns (uint56) {
if (value > type(uint56).max) {
revert SafeCastOverflowedUintDowncast(56, value);
}
return uint56(value);
}
 function toUint48(uint256 value) internal pure returns (uint48) {
if (value > type(uint48).max) {
revert SafeCastOverflowedUintDowncast(48, value);
}
return uint48(value);
}
 function toUint40(uint256 value) internal pure returns (uint40) {
if (value > type(uint40).max) {
revert SafeCastOverflowedUintDowncast(40, value);
}
return uint40(value);
}
 function toUint32(uint256 value) internal pure returns (uint32) {
if (value > type(uint32).max) {
revert SafeCastOverflowedUintDowncast(32, value);
}
return uint32(value);
}
 function toUint24(uint256 value) internal pure returns (uint24) {
if (value > type(uint24).max) {
revert SafeCastOverflowedUintDowncast(24, value);
}
return uint24(value);
}
 function toUint16(uint256 value) internal pure returns (uint16) {
if (value > type(uint16).max) {
revert SafeCastOverflowedUintDowncast(16, value);
}
return uint16(value);
}
 function toUint8(uint256 value) internal pure returns (uint8) {
if (value > type(uint8).max) {
revert SafeCastOverflowedUintDowncast(8, value);
}
return uint8(value);
}
 function toUint256(int256 value) internal pure returns (uint256) {
if (value < 0) {
revert SafeCastOverflowedIntToUint(value);
}
return uint256(value);
}
 function toInt248(int256 value) internal pure returns (int248 downcasted) {
downcasted = int248(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(248, value);
}
}
 function toInt240(int256 value) internal pure returns (int240 downcasted) {
downcasted = int240(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(240, value);
}
}
 function toInt232(int256 value) internal pure returns (int232 downcasted) {
downcasted = int232(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(232, value);
}
}
 function toInt224(int256 value) internal pure returns (int224 downcasted) {
downcasted = int224(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(224, value);
}
}
 function toInt216(int256 value) internal pure returns (int216 downcasted) {
downcasted = int216(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(216, value);
}
}
 function toInt208(int256 value) internal pure returns (int208 downcasted) {
downcasted = int208(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(208, value);
}
}
 function toInt200(int256 value) internal pure returns (int200 downcasted) {
downcasted = int200(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(200, value);
}
}
 function toInt192(int256 value) internal pure returns (int192 downcasted) {
downcasted = int192(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(192, value);
}
}
 function toInt184(int256 value) internal pure returns (int184 downcasted) {
downcasted = int184(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(184, value);
}
}
 function toInt176(int256 value) internal pure returns (int176 downcasted) {
downcasted = int176(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(176, value);
}
}
 function toInt168(int256 value) internal pure returns (int168 downcasted) {
downcasted = int168(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(168, value);
}
}
 function toInt160(int256 value) internal pure returns (int160 downcasted) {
downcasted = int160(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(160, value);
}
}
 function toInt152(int256 value) internal pure returns (int152 downcasted) {
downcasted = int152(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(152, value);
}
}
 function toInt144(int256 value) internal pure returns (int144 downcasted) {
downcasted = int144(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(144, value);
}
}
 function toInt136(int256 value) internal pure returns (int136 downcasted) {
downcasted = int136(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(136, value);
}
}
 function toInt128(int256 value) internal pure returns (int128 downcasted) {
downcasted = int128(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(128, value);
}
}
 function toInt120(int256 value) internal pure returns (int120 downcasted) {
downcasted = int120(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(120, value);
}
}
 function toInt112(int256 value) internal pure returns (int112 downcasted) {
downcasted = int112(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(112, value);
}
}
 function toInt104(int256 value) internal pure returns (int104 downcasted) {
downcasted = int104(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(104, value);
}
}
 function toInt96(int256 value) internal pure returns (int96 downcasted) {
downcasted = int96(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(96, value);
}
}
 function toInt88(int256 value) internal pure returns (int88 downcasted) {
downcasted = int88(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(88, value);
}
}
 function toInt80(int256 value) internal pure returns (int80 downcasted) {
downcasted = int80(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(80, value);
}
}
 function toInt72(int256 value) internal pure returns (int72 downcasted) {
downcasted = int72(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(72, value);
}
}
 function toInt64(int256 value) internal pure returns (int64 downcasted) {
downcasted = int64(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(64, value);
}
}
 function toInt56(int256 value) internal pure returns (int56 downcasted) {
downcasted = int56(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(56, value);
}
}
 function toInt48(int256 value) internal pure returns (int48 downcasted) {
downcasted = int48(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(48, value);
}
}
 function toInt40(int256 value) internal pure returns (int40 downcasted) {
downcasted = int40(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(40, value);
}
}
 function toInt32(int256 value) internal pure returns (int32 downcasted) {
downcasted = int32(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(32, value);
}
}
 function toInt24(int256 value) internal pure returns (int24 downcasted) {
downcasted = int24(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(24, value);
}
}
 function toInt16(int256 value) internal pure returns (int16 downcasted) {
downcasted = int16(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(16, value);
}
}
 function toInt8(int256 value) internal pure returns (int8 downcasted) {
downcasted = int8(value);
if (downcasted != value) {
revert SafeCastOverflowedIntDowncast(8, value);
}
}
 function toInt256(uint256 value) internal pure returns (int256) {
if (value > uint256(type(int256).max)) {
revert SafeCastOverflowedUintToInt(value);
}
return int256(value);
}
 function toUint(bool b) internal pure returns (uint256 u) {
assembly ("memory-safe") {
u := iszero(iszero(b)) }
}
}

This is the subset of OpenZeppelin Contracts used by the Pakka testnet prototype.
Upstream: https://github.com/OpenZeppelin/openzeppelin-contracts/tree/v5.1.0/contracts

Sources are from v5.1.0. IERC4626 is the v5.0.0 interface retrieved from tag v5.0.2.
Documentation comments and formatting in IERC4626, Panic and SafeCast were
normalized because the source retrieval flattened their original line breaks.
Executable statements retain the upstream implementations.

Clones and Errors were added from the same v5.1.0 tag, with documentation and
formatting normalized; their executable statements are unchanged. Sources:
https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts/v5.1.0/contracts/proxy/Clones.sol
https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts/v5.1.0/contracts/utils/Errors.sol

Vendored because this development environment cannot reach the npm registry.
For mainnet preparation, replace this local dependency with the official npm
package and rerun all tests against the original source distribution.

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

interface VmRealVault {
    function envOr(string calldata, string calldata) external returns (string memory);
    function envOr(string calldata, address) external returns (address);
    function envOr(string calldata, uint256) external returns (uint256);
    function createSelectFork(string calldata) external returns (uint256);
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function warp(uint256) external;
    function roll(uint256) external;
    function skip(bool) external;
}
contract RealVaultForkTest {
    VmRealVault constant vm = VmRealVault(address(uint160(uint256(keccak256("hevm cheat code")))));
    function testRealVaultIndexAccruesWithoutDeposit() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        address vaultAddress = vm.envOr("FORK_VAULT_ADDRESS", address(0));
        if (bytes(rpc).length == 0 || vaultAddress == address(0)) { vm.skip(true); return; }
        uint256 pinnedBlock = vm.envOr("FORK_BLOCK_NUMBER", uint256(0));
        if (pinnedBlock == 0) vm.createSelectFork(rpc); else vm.createSelectFork(rpc, pinnedBlock);
        assert(block.chainid == 5042002 || block.chainid == 5042);
        IERC4626 vault = IERC4626(vaultAddress);
        assert(vaultAddress.code.length > 0 && vault.asset() == 0x3600000000000000000000000000000000000000);
        uint256 unit = 10 ** (uint256(vault.decimals()) + 18);
        uint256 supply = vault.totalSupply();
        uint256 beforeIndex = vault.convertToAssets(unit);
        assert(supply > 0 && beforeIndex > 0);
        vm.warp(block.timestamp + 1 days); vm.roll(block.number + 1);
        uint256 afterIndex = vault.convertToAssets(unit);
        // Intentionally strict: an idle/zero-yield/stale-index vault does not satisfy this integration requirement.
        assert(afterIndex > beforeIndex);
        assert(vault.totalSupply() == supply); // This test made no deposit, mint or accrue transaction.
    }
}

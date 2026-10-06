// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PakkaRouter} from "./PakkaRouter.sol";
import {Tijori} from "./Tijori.sol";

/// @notice Creates and atomically initializes one ERC-1167 treasury per owner.
/// @dev No factory administrator, upgrades, custody or creation for another owner.
contract TijoriFactory {
    address public immutable implementation;
    mapping(address => address) public tijoriOf;

    error UnsupportedChain(uint256 chainId);
    error AlreadyExists();

    event TijoriCreated(address indexed owner, address indexed tijori, address indexed agent);

    constructor(PakkaRouter router) {
        if (block.chainid != 5042002 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        implementation = address(new Tijori(router));
    }

    function create(address agent, uint256 dailyCap) external returns (address tijori) {
        if (block.chainid != 5042002 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        if (tijoriOf[msg.sender] != address(0)) revert AlreadyExists();
        tijori = Clones.clone(implementation);
        tijoriOf[msg.sender] = tijori;
        Tijori(tijori).initialize(msg.sender, agent, dailyCap);
        emit TijoriCreated(msg.sender, tijori, agent);
    }
}

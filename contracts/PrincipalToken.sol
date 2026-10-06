// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Principal for one Pakka vault/maturity. Only its YieldToken controls supply.
contract PrincipalToken is ERC20 {
    address public immutable yieldToken;
    uint8 private immutable _assetDecimals;

    error OnlyYieldToken();

    constructor(string memory label, uint8 assetDecimals) ERC20(
        string.concat("Pakka Principal ", label), string.concat("PT-", label)
    ) {
        yieldToken = msg.sender;
        _assetDecimals = assetDecimals;
    }

    function decimals() public view override returns (uint8) {
        return _assetDecimals;
    }

    function mint(address user, uint256 amount) external {
        if (msg.sender != yieldToken) revert OnlyYieldToken();
        _mint(user, amount);
    }

    function burn(address user, uint256 amount) external {
        if (msg.sender != yieldToken) revert OnlyYieldToken();
        _burn(user, amount);
    }
}

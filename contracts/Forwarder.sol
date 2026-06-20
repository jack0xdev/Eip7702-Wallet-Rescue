// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title Forwarder
 * @notice EIP-7702 delegation target. Forwards ALL received ETH to a safe destination.
 * @dev Deploy with EVM version Prague. Victim EOA delegates to this code,
 *      then calls initialize() via delegate to set its own storage slot.
 */
contract Forwarder {
    address payable public DESTINATION;
    bool private _initialized;

    function initialize(address payable _dest) external {
        require(!_initialized, "Already initialized");
        require(_dest != address(0), "Invalid destination");
        _initialized = true;
        DESTINATION = _dest;
    }

    receive() external payable {
        require(DESTINATION != address(0), "Not initialized");
        (bool ok, ) = DESTINATION.call{value: address(this).balance}("");
        require(ok, "Forward failed");
    }

    fallback() external payable {
        require(DESTINATION != address(0), "Not initialized");
        (bool ok, ) = DESTINATION.call{value: address(this).balance}("");
        require(ok, "Forward failed");
    }
}

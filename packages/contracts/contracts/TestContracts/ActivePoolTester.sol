// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../ActivePool.sol";

contract ActivePoolTester is ActivePool {
    
    function unprotectedIncreaseLUSDDebt(uint _amount) external {
        BTUSDDebt  = BTUSDDebt.add(_amount);
    }

    function unprotectedReceiveColl(uint256 _amount) public {
        systemCollateral = systemCollateral.add(_amount);
    }
}

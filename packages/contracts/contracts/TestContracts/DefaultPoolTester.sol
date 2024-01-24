// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../DefaultPool.sol";

contract DefaultPoolTester is DefaultPool {
    
    function unprotectedIncreaseLUSDDebt(uint _amount) external {
        BTUSDDebt  = BTUSDDebt.add(_amount);
    }

    function unprotectedReceiveColl(uint256 _amount) public {
        ETH = ETH.add(_amount);
    }
}

// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../SATO/SATOStaking.sol";


contract SATOStakingTester is SATOStaking {
    function requireCallerIsTroveManager() external view {
        require(msg.sender == troveManagerAddress, "SATOStakingTester: not TroveMgr");
    }
}

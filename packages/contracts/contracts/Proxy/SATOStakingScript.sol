// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/CheckContract.sol";
import "../Interfaces/ISATOStaking.sol";


contract SATOStakingScript is CheckContract {
    ISATOStaking immutable SATOStaking;

    constructor(address _satoStakingAddress) public {
        checkContract(_satoStakingAddress);
        SATOStaking = ISATOStaking(_satoStakingAddress);
    }

    function stake(uint _amount) external {
        SATOStaking.stake(_amount);
    }
}

// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../SATO/CommunityIssuance.sol";

contract CommunityIssuanceTester is CommunityIssuance {
    function obtainSATO(uint _amount) external {
        satoToken.transfer(msg.sender, _amount);
    }

    function getCumulativeIssuanceFraction() external view returns (uint) {
       return _getCumulativeIssuanceFraction();
    }

    function unprotectedIssueSATO() external returns (uint) {
        // No checks on caller address
       
        uint latestTotalSATOIssued = _getLatestIssuedSATO();
        uint issuance = latestTotalSATOIssued.sub(totalSATOIssued);
      
        totalSATOIssued = latestTotalSATOIssued;
        return issuance;
    }
}

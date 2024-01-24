// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

interface ICommunityIssuance { 
    
    // --- Events ---
    
    event SATOTokenAddressSet(address _satoTokenAddress);
    event StabilityPoolAddressSet(address _stabilityPoolAddress);
    event TotalSATOIssuedUpdated(uint _totalSATOIssued);

    // --- Functions ---

    function setAddresses(address _satoTokenAddress, address _stabilityPoolAddress) external;

    function issueSATO() external returns (uint);

    function sendSATO(address _account, uint _amount) external;
	
    function getSATOYetToIssue() external view returns (uint256);
}

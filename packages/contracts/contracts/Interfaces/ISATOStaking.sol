// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

interface ISATOStaking {

    // --- Events --
    
    event SATOTokenAddressSet(address _satoTokenAddress);
    event BTUSDTokenAddressSet(address _debtTokenAddress);
    event TroveManagerAddressSet(address _troveManager);
    event BorrowerOperationsAddressSet(address _borrowerOperationsAddress);
    event ActivePoolAddressSet(address _activePoolAddress);

    event StakeChanged(address indexed staker, uint newStake);
    event StakingGainsWithdrawn(address indexed staker, uint debtGain, uint ETHGain);
    event F_ETHUpdated(uint _F_ETH);
    event F_BTUSDUpdated(uint _F_BTUSD);
    event TotalSATOStakedUpdated(uint _totalSATOStaked);
    event EtherSent(address _account, uint _amount);
    event StakerSnapshotsUpdated(address _staker, uint _F_ETH, uint _F_BTUSD);

    // --- Functions ---

    function setAddresses
    (
        address _satoTokenAddress,
        address _debtTokenAddress,
        address _troveManagerAddress, 
        address _borrowerOperationsAddress,
        address _activePoolAddress,
        address _collAddress
    )  external;

    function stake(uint _amount) external;

    function unstake(uint _amount) external;
	
    function ifPremiumStaking(address _staker) external view returns(bool);
	
    function getStakes(address _staker) external view returns(uint);
	
    function goPremiumStaking() external;

    function increaseF_ETH(uint _ETHFee) external; 

    function increaseF_LUSD(uint _debtMintFee) external;  

    function getPendingETHGain(address _user) external view returns (uint);

    function getPendingLUSDGain(address _user) external view returns (uint);
}

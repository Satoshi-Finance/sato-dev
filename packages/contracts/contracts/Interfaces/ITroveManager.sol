// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./ILiquityBase.sol";
import "./IStabilityPool.sol";
import "./IBTUSDToken.sol";
import "./ISATOToken.sol";
import "./ISATOStaking.sol";


// Common interface for the Trove Manager.
interface ITroveManager is ILiquityBase {
    
    // --- Events ---

    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event PriceFeedAddressChanged(address _newPriceFeedAddress);
    event BTUSDTokenAddressChanged(address _newDebtTokenAddress);
    event ActivePoolAddressChanged(address _activePoolAddress);
    event DefaultPoolAddressChanged(address _defaultPoolAddress);
    event StabilityPoolAddressChanged(address _stabilityPoolAddress);
    event CollSurplusPoolAddressChanged(address _collSurplusPoolAddress);
    event SATOTokenAddressChanged(address _satoTokenAddress);
    event SATOStakingAddressChanged(address _satoStakingAddress);

    event Liquidation(uint _liquidatedDebt, uint _liquidatedColl, uint _collGasCompensation);
    event Redemption(uint _attemptedDebtAmount, uint _actualDebtAmount, uint _ETHSent, uint _ETHFee);
    event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint stake, uint8 operation);
    event TroveLiquidated(address indexed _borrower, uint _debt, uint _coll, uint8 operation);
    event BaseRateUpdated(uint _baseRate);
    event LastFeeOpTimeUpdated(uint _lastFeeOpTime);
    event TotalStakesUpdated(uint _newTotalStakes);
    event SystemSnapshotsUpdated(uint _totalStakesSnapshot, uint _totalCollateralSnapshot);
    event LTermsUpdated(uint _L_ETH, uint _L_Debt);
    event RTermsUpdated(uint _R_Coll, uint _R_Debt);
    event TroveSnapshotsUpdated(uint _L_ETH, uint _L_Debt);
    event TroveRedemptionSnapshotsUpdated(address _borrower, uint _R_Coll, uint _R_Debt);
    event TroveIndexUpdated(address _borrower, uint _newIndex);
    event ScavengeFreeDebt(address indexed _borrower, address indexed _scavenger, uint _freeDebt, uint _collSurplus, uint _reward);
    event ScavengeBelowMinimum(address indexed _borrower, address indexed _scavenger, uint _collSurplus, uint _collToScavenger, uint _debt);

    // --- Functions ---

    function setAddresses(
        address _borrowerOperationsAddress,
        address _activePoolAddress,
        address _defaultPoolAddress,
        address _stabilityPoolAddress,
        address _collSurplusPoolAddress,
        address _priceFeedAddress,
        address _debtTokenAddress,
        address _satoTokenAddress,
        address _satoStakingAddress,
        address _collAddress
    ) external;

    function stabilityPool() external view returns (IStabilityPool);
    function debtToken() external view returns (IBTUSDToken);
    function satoToken() external view returns (ISATOToken);
    function satoStaking() external view returns (ISATOStaking);

    function getTroveOwnersCount() external view returns (uint);

    function getTroveFromTroveOwnersArray(uint _index) external view returns (address);

    function getCurrentICR(address _borrower, uint _price) external view returns (uint);

    function liquidate(address _borrower) external;

    function batchLiquidateTroves(address[] calldata _troveArray) external;

    function redeemCollateral(
        uint _debtAmount,
        uint _maxFee
    ) external; 

    function updateStakeAndTotalStakes(address _borrower) external returns (uint);

    function updateTroveRewardSnapshots(address _borrower) external;

    function updateTroveRedemptionSnapshots(address _borrower) external;

    function addTroveOwnerToArray(address _borrower) external returns (uint index);

    function applyPendingRewards(address _borrower) external returns (bool);

    function getPendingETHReward(address _borrower) external view returns (uint);
	
    function getPendingCollRedemption(address _borrower) external view returns (uint);

    function getPendingLUSDDebtReward(address _borrower) external view returns (uint);
	
    function getPendingDebtRedemption(address _borrower) external view returns (uint);

    function hasPendingRewards(address _borrower) external view returns (bool);

    function hasPendingRedemptionShare(address _borrower) external view returns (bool);

    function getEntireDebtAndColl(address _borrower) external view returns (
        uint debt, 
        uint coll, 
        uint pendingDebtReward, 
        uint pendingETHReward, 
        uint pendingRedemptionDebt, 
        uint pendingRedemptionColl,
        uint pendingFreeDebt
    );

    function closeTrove(address _borrower) external;

    function removeStake(address _borrower) external;

    function getRedemptionRateForRedeemer(address _redeemer) external view returns (uint);
    function getRedemptionRateWithDecayForRedeemer(address _redeemer) external view returns (uint);
    function getRedemptionFeeWithDecayForRedeemer(address _redeemer, uint _collDrawn) external view returns (uint);
    function getUpdatedRedemptionBaseRate(uint _collDrawn, uint _price, uint _debtTotalSupply) external view returns (uint);

    function getBorrowingRateForBorrower(address _borrower) external view returns (uint);
    function getBorrowingRateWithDecayForBorrower(address _borrower) external view returns (uint);

    function getBorrowingFeeForBorrower(address _borrower, uint _debt) external view returns (uint);
    function getBorrowingFeeWithDecayForBorrower(address _borrower, uint _debt) external view returns (uint);

    function decayBaseRateFromBorrowing() external;

    function getTroveStatus(address _borrower) external view returns (uint);
    
    function getTroveStake(address _borrower) external view returns (uint);

    function getTroveDebt(address _borrower) external view returns (uint);

    function getTroveColl(address _borrower) external view returns (uint);

    function setTroveStatus(address _borrower, uint num) external;

    function increaseTroveColl(address _borrower, uint _collIncrease) external returns (uint);

    function decreaseTroveColl(address _borrower, uint _collDecrease) external returns (uint); 

    function increaseTroveDebt(address _borrower, uint _debtIncrease) external returns (uint); 

    function decreaseTroveDebt(address _borrower, uint _collDecrease) external returns (uint); 

    function getTCR(uint _price) external view returns (uint);

    function checkRecoveryMode(uint _price) external view returns (bool);
	
    function scavengeTrove(address _borrower) external;
}

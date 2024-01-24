// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/SafeMath.sol";
import "../Dependencies/LiquityMath.sol";
import "../Dependencies/IERC20.sol";
import "../Interfaces/IBorrowerOperations.sol";
import "../Interfaces/ITroveManager.sol";
import "../Interfaces/IStabilityPool.sol";
import "../Interfaces/IPriceFeed.sol";
import "../Interfaces/ISATOStaking.sol";
import "./BorrowerOperationsScript.sol";
import "./ETHTransferScript.sol";
import "./SATOStakingScript.sol";
import "../Dependencies/console.sol";


contract BorrowerWrappersScript is BorrowerOperationsScript, ETHTransferScript, SATOStakingScript {
    using SafeMath for uint;

    string constant public NAME = "BorrowerWrappersScript";

    ITroveManager immutable troveManager;
    IStabilityPool immutable stabilityPool;
    IPriceFeed immutable priceFeed;
    IERC20 immutable debtToken;
    IERC20 immutable satoToken;
    ISATOStaking immutable satoStaking;
    IERC20 immutable collateral;

    constructor(
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _satoStakingAddress,
        address _collAddress
    )
        BorrowerOperationsScript(IBorrowerOperations(_borrowerOperationsAddress))
        SATOStakingScript(_satoStakingAddress)
        public
    {
        checkContract(_troveManagerAddress);
        ITroveManager troveManagerCached = ITroveManager(_troveManagerAddress);
        troveManager = troveManagerCached;

        IStabilityPool stabilityPoolCached = troveManagerCached.stabilityPool();
        checkContract(address(stabilityPoolCached));
        stabilityPool = stabilityPoolCached;

        IPriceFeed priceFeedCached = troveManagerCached.priceFeed();
        checkContract(address(priceFeedCached));
        priceFeed = priceFeedCached;

        address debtTokenCached = address(troveManagerCached.debtToken());
        checkContract(debtTokenCached);
        debtToken = IERC20(debtTokenCached);

        address satoTokenCached = address(troveManagerCached.satoToken());
        checkContract(satoTokenCached);
        satoToken = IERC20(satoTokenCached);
        collateral = IERC20(_collAddress);

        ISATOStaking satoStakingCached = troveManagerCached.satoStaking();
        require(_satoStakingAddress == address(satoStakingCached), "BorrowerWrappersScript: Wrong SATOStaking address");
        satoStaking = satoStakingCached;
    }

    function claimCollateralAndOpenTrove(uint _maxFee, uint _debtAmount, uint _collAmt) external {
        uint balanceBefore = collateral.balanceOf(address(this));

        // Claim collateral
        borrowerOperations.claimCollateral();

        uint balanceAfter = collateral.balanceOf(address(this));

        // already checked in CollSurplusPool
        require(balanceAfter > balanceBefore, "BorrowerWrappersScript: wrong balance after claimCollateral");

        uint totalCollateral = balanceAfter.sub(balanceBefore).add(_collAmt);

        // Open trove with obtained collateral, plus collateral sent by user		
        collateral.approve(address(borrowerOperations), type(uint256).max);
        require(collateral.balanceOf(address(this)) >= totalCollateral, "BorrowerWrappersScript: not enough balance for openTrove");
        borrowerOperations.openTrove(_maxFee, _debtAmount, totalCollateral);
    }

    function claimSPRewardsAndRecycle(uint _maxFee) external {
        uint collBalanceBefore = collateral.balanceOf(address(this));
        uint satoBalanceBefore = satoToken.balanceOf(address(this));

        // Claim rewards
        stabilityPool.withdrawFromSP(0);

        uint collBalanceAfter = collateral.balanceOf(address(this));
        uint satoBalanceAfter = satoToken.balanceOf(address(this));
        uint claimedCollateral = collBalanceAfter.sub(collBalanceBefore);

        // Add claimed ETH to trove, get more debt and stake it into the Stability Pool
        if (claimedCollateral > 0) {
            _requireUserHasTrove(address(this));
            uint debtAmount = _getNetDebtAmount(claimedCollateral);		
            collateral.approve(address(borrowerOperations), type(uint256).max);
            require(collateral.balanceOf(address(this)) >= claimedCollateral, "BorrowerWrappersScript: not enough balance for adjustTrove");
            borrowerOperations.adjustTrove(_maxFee, claimedCollateral, true, debtAmount, true);
            // Provide withdrawn debt to Stability Pool
            if (debtAmount > 0) {
                stabilityPool.provideToSP(debtAmount, address(0));
            }
        }

        // Stake claimed SATO
        uint claimedSATO = satoBalanceAfter.sub(satoBalanceBefore);
        if (claimedSATO > 0) {
            satoStaking.stake(claimedSATO);
        }
    }

    function claimStakingGainsAndRecycle(uint _maxFee) external {
        uint collBalanceBefore = collateral.balanceOf(address(this));
        uint debtBalanceBefore = debtToken.balanceOf(address(this));
        uint satoBalanceBefore = satoToken.balanceOf(address(this));

        // Claim gains
        satoStaking.unstake(0);

        uint gainedCollateral = collateral.balanceOf(address(this)).sub(collBalanceBefore); // stack too deep issues :'(
        uint gainedDebt = debtToken.balanceOf(address(this)).sub(debtBalanceBefore);

        uint netDebtAmount;
        // Top up trove and get more debt, keeping ICR constant
        if (gainedCollateral > 0) {
            _requireUserHasTrove(address(this));
            netDebtAmount = _getNetDebtAmount(gainedCollateral);	
            collateral.approve(address(borrowerOperations), type(uint256).max);
            require(collateral.balanceOf(address(this)) >= gainedCollateral, "BorrowerWrappersScript: not enough balance for adjustTrove");
            borrowerOperations.adjustTrove(_maxFee, gainedCollateral, true, netDebtAmount, true);
        }

        uint totalDebt = gainedDebt.add(netDebtAmount);
        if (totalDebt > 0) {
            stabilityPool.provideToSP(totalDebt, address(0));

            // Providing to Stability Pool also triggers SATO claim, so stake it if any
            uint satoBalanceAfter = satoToken.balanceOf(address(this));
            uint claimedSATO = satoBalanceAfter.sub(satoBalanceBefore);
            if (claimedSATO > 0) {
                satoStaking.stake(claimedSATO);
            }
        }

    }

    function _getNetDebtAmount(uint _collateral) internal returns (uint) {
        uint price = priceFeed.fetchPrice();
        uint ICR = troveManager.getCurrentICR(address(this), price);

        uint debtAmount = _collateral.mul(price).div(ICR);
        uint borrowingRate = troveManager.getBorrowingRateWithDecayForBorrower(address(this));
        uint netDebt = debtAmount.mul(LiquityMath.DECIMAL_PRECISION).div(LiquityMath.DECIMAL_PRECISION.add(borrowingRate));

        return netDebt;
    }

    function _requireUserHasTrove(address _depositor) internal view {
        require(troveManager.getTroveStatus(_depositor) == 1, "BorrowerWrappersScript: caller must have an active trove");
    }
}

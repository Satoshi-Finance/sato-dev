// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IStabilityPool.sol";
import "./Interfaces/ICollSurplusPool.sol";
import "./Interfaces/IBTUSDToken.sol";
import "./Interfaces/ISATOToken.sol";
import "./Interfaces/ISATOStaking.sol";
import "./Dependencies/LiquityBase.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/IERC20.sol";

contract TroveManager is LiquityBase, Ownable, CheckContract, ITroveManager {
    string constant public NAME = "TroveManager";

    // --- Connected contract declarations ---

    address public borrowerOperationsAddress;

    IStabilityPool public override stabilityPool;

    ICollSurplusPool collSurplusPool;

    IBTUSDToken public override debtToken;

    ISATOToken public override satoToken;

    ISATOStaking public override satoStaking;
	
    IERC20 public collateral;

    // --- Data structures ---

    uint constant public SECONDS_IN_ONE_MINUTE = 60;
    /*
     * Half-life of 12h. 12h = 720 min
     * (1/2) = d^720 => d = (1/2)^(1/720)
     */
    uint constant public MINUTE_DECAY_FACTOR = 999037758833783000;
    uint constant public REDEMPTION_FEE_FLOOR = DECIMAL_PRECISION / 1000 * 5; // 0.5%
    uint constant public REDEMPTION_FEE_FLOOR_PREMIUM = 4000000000000000; // 0.4%
    uint constant public MAX_BORROWING_FEE = DECIMAL_PRECISION / 100 * 5; // 5%

    // During bootsrap period redemptions are not allowed
    uint constant public BOOTSTRAP_PERIOD = 14 days;

    // maximum Troves allowed to be liquidated in a single batch liquidation tx
    uint constant public LIQBATCH_SIZE_LIMIT = 50;

    /*
    * BETA: 18 digit decimal. Parameter by which to divide the redeemed fraction, in order to calc the new base rate from a redemption.
    * Corresponds to (1 / ALPHA) in the white paper.
    */
    uint constant public BETA = 2;

    uint public baseRate;

    // The timestamp of the latest fee operation (redemption or new debt issuance)
    uint public lastFeeOperationTime;

    enum Status {
        nonExistent,
        active,
        closedByOwner,
        closedByLiquidation,
        closedByRedemption
    }

    // Store the necessary data for a trove
    struct Trove {
        uint debt;
        uint coll;
        uint stake;
        Status status;
        uint128 arrayIndex;
    }

    mapping (address => Trove) public Troves;

    uint public totalStakes;

    // Snapshot of the value of totalStakes, taken immediately after the latest liquidation
    uint public totalStakesSnapshot;

    // Snapshot of the total collateral across the ActivePool and DefaultPool, immediately after the latest liquidation.
    uint public totalCollateralSnapshot;

    /*
    * L_ETH and L_Debt track the sums of accumulated liquidation rewards per unit staked. During its lifetime, each stake earns:
    *
    * An ETH gain of ( stake * [L_ETH - L_ETH(0)] )
    * A debt increase  of ( stake * [L_Debt - L_Debt(0)] )
    *
    * Where L_ETH(0) and L_Debt(0) are snapshots of L_ETH and L_Debt for the active Trove taken at the instant the stake was made
    */
    uint public L_ETH;
    uint public L_LUSDDebt;
    /// @dev sums of accumulated redemption share of collateral per unit staked
    uint public R_Coll;
    /// @dev sums of accumulated redemption share of debt per unit staked
    uint public R_Debt;

    // Map addresses with active troves to their RewardSnapshot
    mapping (address => RewardSnapshot) public rewardSnapshots;
    // Map addresses with active troves to their RedemptionShareSnapshot
    mapping (address => RedemptionShareSnapshot) public redemptionSnapshots;

    // Object containing the collateral and debt snapshots for a given active trove
    struct RewardSnapshot { uint ETH; uint Debt;}

    // Object containing the redemption tracking snapshots for a given active trove
    struct RedemptionShareSnapshot { uint rColl; uint rDebt;}

    // Array of all active trove addresses - used to to compute an approximate hint off-chain, for the sorted list insertion
    address[] public TroveOwners;

    // Error trackers for the trove redistribution calculation
    uint public lastETHError_Redistribution;
    uint public lastLUSDDebtError_Redistribution;

    // Error trackers for the trove redemption share calculation
    uint public lastCollError_RedemptionShare;
    uint public lastDebtError_RedemptionShare;

    /*
    * --- Variable container structs for liquidations ---
    *
    * These structs are used to hold, return and assign variables inside the liquidation functions,
    * in order to avoid the error: "CompilerError: Stack too deep".
    **/

    struct LocalVariables_OuterLiquidationFunction {
        uint price;
        uint debtInStabPool;
        bool recoveryModeAtStart;
        uint liquidatedDebt;
        uint liquidatedColl;
    }

    struct LocalVariables_InnerSingleLiquidateFunction {
        uint collToLiquidate;
        uint pendingDebtReward;
        uint pendingCollReward;
    }

    struct LocalVariables_LiquidationSequence {
        uint remainingDebtInStabPool;
        uint i;
        uint ICR;
        address user;
        bool backToNormalMode;
        uint entireSystemDebt;
        uint entireSystemColl;
    }

    struct LiquidationValues {
        uint entireTroveDebt;
        uint entireTroveColl;
        uint collGasCompensation;
        uint debtToOffset;
        uint collToSendToSP;
        uint debtToRedistribute;
        uint collToRedistribute;
        uint collSurplus;
        uint pendingRedemptionDebt;
        uint pendingFreeDebt;
    }

    struct LiquidationTotals {
        uint totalCollInSequence;
        uint totalDebtInSequence;
        uint totalCollGasCompensation;
        uint totalDebtToOffset;
        uint totalCollToSendToSP;
        uint totalDebtToRedistribute;
        uint totalCollToRedistribute;
        uint totalCollSurplus;
    }

    struct ContractsCache {
        IActivePool activePool;
        IDefaultPool defaultPool;
        IBTUSDToken debtToken;
        ISATOStaking satoStaking;
        ICollSurplusPool collSurplusPool;
    }
    // --- Variable container structs for redemptions ---

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
    event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint _stake, TroveManagerOperation _operation);
    event TroveLiquidated(address indexed _borrower, uint _debt, uint _coll, TroveManagerOperation _operation);
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

    enum TroveManagerOperation {
        applyPendingRewards,
        liquidateInNormalMode,
        liquidateInRecoveryMode,
        redeemCollateral
    }

    // --- Dependency setter ---

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
    )
        external
        override
        onlyOwner
    {
        checkContract(_borrowerOperationsAddress);
        checkContract(_activePoolAddress);
        checkContract(_defaultPoolAddress);
        checkContract(_stabilityPoolAddress);
        checkContract(_collSurplusPoolAddress);
        checkContract(_priceFeedAddress);
        checkContract(_debtTokenAddress);
        checkContract(_satoTokenAddress);
        checkContract(_satoStakingAddress);
        checkContract(_collAddress);

        borrowerOperationsAddress = _borrowerOperationsAddress;
        activePool = IActivePool(_activePoolAddress);
        defaultPool = IDefaultPool(_defaultPoolAddress);
        stabilityPool = IStabilityPool(_stabilityPoolAddress);
        collSurplusPool = ICollSurplusPool(_collSurplusPoolAddress);
        priceFeed = IPriceFeed(_priceFeedAddress);
        debtToken = IBTUSDToken(_debtTokenAddress);
        satoToken = ISATOToken(_satoTokenAddress);
        satoStaking = ISATOStaking(_satoStakingAddress);
        collateral = IERC20(_collAddress);

        emit BorrowerOperationsAddressChanged(_borrowerOperationsAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);
        emit DefaultPoolAddressChanged(_defaultPoolAddress);
        emit StabilityPoolAddressChanged(_stabilityPoolAddress);
        emit CollSurplusPoolAddressChanged(_collSurplusPoolAddress);
        emit PriceFeedAddressChanged(_priceFeedAddress);
        emit BTUSDTokenAddressChanged(_debtTokenAddress);
        emit SATOTokenAddressChanged(_satoTokenAddress);
        emit SATOStakingAddressChanged(_satoStakingAddress);

        _renounceOwnership();
    }

    // --- Getters ---

    function getTroveOwnersCount() external view override returns (uint) {
        return TroveOwners.length;
    }

    function getTroveFromTroveOwnersArray(uint _index) external view override returns (address) {
        return TroveOwners[_index];
    }

    // --- Trove Liquidation functions ---

    // Single liquidation function. Closes the trove if its ICR is lower than the minimum collateral ratio.
    function liquidate(address _borrower) external override {
        _requireTroveIsActive(_borrower);

        address[] memory borrowers = new address[](1);
        borrowers[0] = _borrower;
        batchLiquidateTroves(borrowers);
    }

    // --- Inner single liquidation functions ---

    // Liquidate one trove, in Normal Mode.
    function _liquidateNormalMode(
        IActivePool _activePool,
        IDefaultPool _defaultPool,
        address _borrower,
        uint _debtInStabPool
    )
        internal
        returns (LiquidationValues memory singleLiquidation)
    {
        LocalVariables_InnerSingleLiquidateFunction memory vars;

        (singleLiquidation.entireTroveDebt,
        singleLiquidation.entireTroveColl,
        vars.pendingDebtReward,
        vars.pendingCollReward, 
        singleLiquidation.pendingRedemptionDebt,,
        singleLiquidation.pendingFreeDebt) = getEntireDebtAndColl(_borrower);

        _updateTroveWithDistribution(_borrower, singleLiquidation.entireTroveDebt, singleLiquidation.entireTroveColl, vars.pendingDebtReward, vars.pendingCollReward);
        _applyRedemptionAccounting(_borrower, singleLiquidation.pendingRedemptionDebt, singleLiquidation.pendingFreeDebt);
        _removeStake(_borrower);

        singleLiquidation.collGasCompensation = _getCollGasCompensation(singleLiquidation.entireTroveColl);
        uint collToLiquidate = singleLiquidation.entireTroveColl.sub(singleLiquidation.collGasCompensation);

        (singleLiquidation.debtToOffset,
        singleLiquidation.collToSendToSP,
        singleLiquidation.debtToRedistribute,
        singleLiquidation.collToRedistribute) = _getOffsetAndRedistributionVals(singleLiquidation.entireTroveDebt, collToLiquidate, _debtInStabPool);

        _closeTrove(_borrower, Status.closedByLiquidation);
        emit TroveLiquidated(_borrower, singleLiquidation.entireTroveDebt, singleLiquidation.entireTroveColl, TroveManagerOperation.liquidateInNormalMode);
        emit TroveUpdated(_borrower, 0, 0, 0, TroveManagerOperation.liquidateInNormalMode);
        return singleLiquidation;
    }

    // Liquidate one trove, in Recovery Mode.
    function _liquidateRecoveryMode(
        IActivePool _activePool,
        IDefaultPool _defaultPool,
        address _borrower,
        uint _ICR,
        uint _debtInStabPool,
        uint _TCR,
        uint _price
    )
        internal
        returns (LiquidationValues memory singleLiquidation)
    {
        LocalVariables_InnerSingleLiquidateFunction memory vars;
        if (TroveOwners.length <= 1) {return singleLiquidation;} // don't liquidate if last trove
        (singleLiquidation.entireTroveDebt,
        singleLiquidation.entireTroveColl,
        vars.pendingDebtReward,
        vars.pendingCollReward, 
        singleLiquidation.pendingRedemptionDebt,,
        singleLiquidation.pendingFreeDebt) = getEntireDebtAndColl(_borrower);

        singleLiquidation.collGasCompensation = _getCollGasCompensation(singleLiquidation.entireTroveColl);
        vars.collToLiquidate = singleLiquidation.entireTroveColl.sub(singleLiquidation.collGasCompensation);

        // If ICR <= 100%, purely redistribute the Trove across all active Troves
        if (_ICR <= _100pct) {
            _updateTroveWithDistribution(_borrower, singleLiquidation.entireTroveDebt, singleLiquidation.entireTroveColl, vars.pendingDebtReward, vars.pendingCollReward);
            _applyRedemptionAccounting(_borrower, singleLiquidation.pendingRedemptionDebt, singleLiquidation.pendingFreeDebt);
            _removeStake(_borrower);
           
            singleLiquidation.debtToOffset = 0;
            singleLiquidation.collToSendToSP = 0;
            singleLiquidation.debtToRedistribute = singleLiquidation.entireTroveDebt;
            singleLiquidation.collToRedistribute = vars.collToLiquidate;

            _closeTrove(_borrower, Status.closedByLiquidation);
            emit TroveLiquidated(_borrower, singleLiquidation.entireTroveDebt, singleLiquidation.entireTroveColl, TroveManagerOperation.liquidateInRecoveryMode);
            emit TroveUpdated(_borrower, 0, 0, 0, TroveManagerOperation.liquidateInRecoveryMode);
            
        // If 100% < ICR < MCR, offset as much as possible, and redistribute the remainder
        } else if ((_ICR > _100pct) && (_ICR < MCR)) {
            _updateTroveWithDistribution(_borrower, singleLiquidation.entireTroveDebt, singleLiquidation.entireTroveColl, vars.pendingDebtReward, vars.pendingCollReward);
            _applyRedemptionAccounting(_borrower, singleLiquidation.pendingRedemptionDebt, singleLiquidation.pendingFreeDebt);
            _removeStake(_borrower);

            (singleLiquidation.debtToOffset,
            singleLiquidation.collToSendToSP,
            singleLiquidation.debtToRedistribute,
            singleLiquidation.collToRedistribute) = _getOffsetAndRedistributionVals(singleLiquidation.entireTroveDebt, vars.collToLiquidate, _debtInStabPool);

            _closeTrove(_borrower, Status.closedByLiquidation);
            emit TroveLiquidated(_borrower, singleLiquidation.entireTroveDebt, singleLiquidation.entireTroveColl, TroveManagerOperation.liquidateInRecoveryMode);
            emit TroveUpdated(_borrower, 0, 0, 0, TroveManagerOperation.liquidateInRecoveryMode);
        /*
        * If 110% <= ICR < current TCR (accounting for the preceding liquidations in the current sequence)
        * and there is debt token in the Stability Pool, only offset, with no redistribution,
        * but at a capped rate of 1.1 and only if the whole debt can be liquidated.
        * The remainder due to the capped rate will be claimable as collateral surplus.
        */
        } else if ((_ICR >= MCR) && _checkIfLiquidatableForTrove(_TCR, true, _ICR) && (singleLiquidation.entireTroveDebt <= _debtInStabPool)) {
            _updateTroveWithDistribution(_borrower, singleLiquidation.entireTroveDebt, singleLiquidation.entireTroveColl, vars.pendingDebtReward, vars.pendingCollReward);
            _applyRedemptionAccounting(_borrower, singleLiquidation.pendingRedemptionDebt, singleLiquidation.pendingFreeDebt);
            assert(_debtInStabPool != 0);

            _removeStake(_borrower);
            singleLiquidation = _getCappedOffsetVals(singleLiquidation.entireTroveDebt, singleLiquidation.entireTroveColl, _price, _borrower);

            _closeTrove(_borrower, Status.closedByLiquidation);
            if (singleLiquidation.collSurplus > 0) {
                collSurplusPool.accountSurplus(_borrower, singleLiquidation.collSurplus);
            }

            emit TroveLiquidated(_borrower, singleLiquidation.entireTroveDebt, singleLiquidation.collToSendToSP, TroveManagerOperation.liquidateInRecoveryMode);
            emit TroveUpdated(_borrower, 0, 0, 0, TroveManagerOperation.liquidateInRecoveryMode);

        } else { // if (_ICR >= MCR && ( _ICR >= _TCR || singleLiquidation.entireTroveDebt > _debtInStabPool))
            LiquidationValues memory zeroVals;
            return zeroVals;
        }

        return singleLiquidation;
    }

    /* In a full liquidation, returns the values for a trove's coll and debt to be offset, and coll and debt to be
    * redistributed to active troves.
    */
    function _getOffsetAndRedistributionVals
    (
        uint _debt,
        uint _coll,
        uint _debtInStabPool
    )
        internal
        pure
        returns (uint debtToOffset, uint collToSendToSP, uint debtToRedistribute, uint collToRedistribute)
    {
        if (_debtInStabPool > 0) {
        /*
        * Offset as much debt & collateral as possible against the Stability Pool, and redistribute the remainder
        * between all active troves.
        *
        *  If the trove's debt is larger than the deposited amount in the Stability Pool:
        *
        *  - Offset an amount of the trove's debt equally in the Stability Pool
        *  - Send a fraction of the trove's collateral to the Stability Pool, equal to the fraction of its offset debt
        *
        */
            debtToOffset = LiquityMath._min(_debt, _debtInStabPool);
            collToSendToSP = _coll.mul(debtToOffset).div(_debt);
            debtToRedistribute = _debt.sub(debtToOffset);
            collToRedistribute = _coll.sub(collToSendToSP);
        } else {
            debtToOffset = 0;
            collToSendToSP = 0;
            debtToRedistribute = _debt;
            collToRedistribute = _coll;
        }
    }

    /*
    *  Get its offset coll/debt and collateral gas comp, and close the trove.
    *  Used in Recovery Mode when TCR > ICR >= MCR & Stability Pool deposit > trove's debt
    */
    function _getCappedOffsetVals
    (
        uint _entireTroveDebt,
        uint _entireTroveColl,
        uint _price,
        address _borrower
    )
        internal
        view
        returns (LiquidationValues memory singleLiquidation)
    {
        singleLiquidation.entireTroveDebt = _entireTroveDebt;
        singleLiquidation.entireTroveColl = _entireTroveColl;
        bool _premiumBorrower = satoStaking.ifPremiumStaking(_borrower);
        uint cappedCollPortion = _entireTroveDebt.mul(_premiumBorrower? PREMIUM_LIQ_RATIO : MCR).div(_price);

        singleLiquidation.collGasCompensation = _getCollGasCompensation(cappedCollPortion);

        singleLiquidation.debtToOffset = _entireTroveDebt;
        singleLiquidation.collToSendToSP = cappedCollPortion.sub(singleLiquidation.collGasCompensation);
        singleLiquidation.collSurplus = _entireTroveColl.sub(cappedCollPortion);
        singleLiquidation.debtToRedistribute = 0;
        singleLiquidation.collToRedistribute = 0;
    }

    /*
    * Attempt to liquidate a custom list of troves provided by the caller.
    */
    function batchLiquidateTroves(address[] memory _troveArray) public override {
        require(_troveArray.length != 0, "TroveManager: Calldata address array must not be empty");
        require(_troveArray.length <= LIQBATCH_SIZE_LIMIT, "TroveManager: too many Troves to liquidate");

        IActivePool activePoolCached = activePool;
        IDefaultPool defaultPoolCached = defaultPool;
        IStabilityPool stabilityPoolCached = stabilityPool;

        LocalVariables_OuterLiquidationFunction memory vars;
        LiquidationTotals memory totals;

        vars.price = priceFeed.fetchPrice();
        vars.debtInStabPool = stabilityPoolCached.getTotalDebtDeposits();
        vars.recoveryModeAtStart = _checkRecoveryMode(vars.price);

        // Perform the appropriate liquidation sequence - tally values and obtain their totals.
        if (vars.recoveryModeAtStart) {
            totals = _getTotalFromBatchLiquidate_RecoveryMode(activePoolCached, defaultPoolCached, vars.price, vars.debtInStabPool, _troveArray);
        } else {  //  if !vars.recoveryModeAtStart
            totals = _getTotalsFromBatchLiquidate_NormalMode(activePoolCached, defaultPoolCached, vars.price, vars.debtInStabPool, _troveArray);
        }

        require(totals.totalDebtInSequence > 0, "TroveManager: nothing to liquidate");

        // Move liquidated collateral and debt to the appropriate pools
        stabilityPoolCached.offset(totals.totalDebtToOffset, totals.totalCollToSendToSP);
        _redistributeDebtAndColl(activePoolCached, defaultPoolCached, totals.totalDebtToRedistribute, totals.totalCollToRedistribute);
        if (totals.totalCollSurplus > 0) {
            activePoolCached.sendETH(address(collSurplusPool), totals.totalCollSurplus);
        }

        // Update system snapshots
        _updateSystemSnapshots_excludeCollRemainder(activePoolCached, totals.totalCollGasCompensation);

        vars.liquidatedDebt = totals.totalDebtInSequence;
        vars.liquidatedColl = totals.totalCollInSequence.sub(totals.totalCollGasCompensation).sub(totals.totalCollSurplus);
        emit Liquidation(vars.liquidatedDebt, vars.liquidatedColl, totals.totalCollGasCompensation);

        // Send gas compensation to caller
        _sendGasCompensation(activePoolCached, msg.sender, totals.totalCollGasCompensation);
    }

    /*
    * This function is used when the batch liquidation sequence starts during Recovery Mode. However, it
    * handle the case where the system *leaves* Recovery Mode, part way through the liquidation sequence
    */
    function _getTotalFromBatchLiquidate_RecoveryMode
    (
        IActivePool _activePool,
        IDefaultPool _defaultPool,
        uint _price,
        uint _debtInStabPool,
        address[] memory _troveArray
    )
        internal
        returns(LiquidationTotals memory totals)
    {
        LocalVariables_LiquidationSequence memory vars;
        LiquidationValues memory singleLiquidation;

        vars.remainingDebtInStabPool = _debtInStabPool;
        vars.backToNormalMode = false;
        vars.entireSystemDebt = getEntireSystemDebt().sub(activePool.getRedeemedDebt());
        vars.entireSystemColl = getEntireSystemColl();

        for (vars.i = 0; vars.i < _troveArray.length; vars.i++) {
            vars.user = _troveArray[vars.i];
            // Skip non-active troves
            if (Troves[vars.user].status != Status.active) { continue; }
            vars.ICR = getCurrentICR(vars.user, _price);

            if (!vars.backToNormalMode) {

                // Skip this trove if ICR is greater than MCR and Stability Pool is empty
                if (vars.ICR >= MCR && vars.remainingDebtInStabPool == 0) { continue; }

                uint TCR = LiquityMath._computeCR(vars.entireSystemColl, vars.entireSystemDebt, _price);

                singleLiquidation = _liquidateRecoveryMode(_activePool, _defaultPool, vars.user, vars.ICR, vars.remainingDebtInStabPool, TCR, _price);

                // Update aggregate trackers
                vars.remainingDebtInStabPool = vars.remainingDebtInStabPool.sub(singleLiquidation.debtToOffset);
                vars.entireSystemDebt = vars.entireSystemDebt.sub(singleLiquidation.debtToOffset);
                vars.entireSystemColl = vars.entireSystemColl.
                    sub(singleLiquidation.collToSendToSP).
                    sub(singleLiquidation.collGasCompensation).
                    sub(singleLiquidation.collSurplus);

                // Add liquidation values to their respective running totals
                totals = _addLiquidationValuesToTotals(totals, singleLiquidation);

                vars.backToNormalMode = !_checkPotentialRecoveryMode(vars.entireSystemColl, vars.entireSystemDebt, _price);
            }

            else if (vars.backToNormalMode && _checkIfLiquidatableForTrove(CCR, false, vars.ICR)) {
                singleLiquidation = _liquidateNormalMode(_activePool, _defaultPool, vars.user, vars.remainingDebtInStabPool);
                vars.remainingDebtInStabPool = vars.remainingDebtInStabPool.sub(singleLiquidation.debtToOffset);

                // Add liquidation values to their respective running totals
                totals = _addLiquidationValuesToTotals(totals, singleLiquidation);

            } else continue; // In Normal Mode skip troves with ICR >= MCR
        }
    }

    function _getTotalsFromBatchLiquidate_NormalMode
    (
        IActivePool _activePool,
        IDefaultPool _defaultPool,
        uint _price,
        uint _debtInStabPool,
        address[] memory _troveArray
    )
        internal
        returns(LiquidationTotals memory totals)
    {
        LocalVariables_LiquidationSequence memory vars;
        LiquidationValues memory singleLiquidation;

        vars.remainingDebtInStabPool = _debtInStabPool;

        for (vars.i = 0; vars.i < _troveArray.length; vars.i++) {
            vars.user = _troveArray[vars.i];
            vars.ICR = getCurrentICR(vars.user, _price);

            if (_checkIfLiquidatableForTrove(CCR, false, vars.ICR)) {
                singleLiquidation = _liquidateNormalMode(_activePool, _defaultPool, vars.user, vars.remainingDebtInStabPool);
                vars.remainingDebtInStabPool = vars.remainingDebtInStabPool.sub(singleLiquidation.debtToOffset);

                // Add liquidation values to their respective running totals
                totals = _addLiquidationValuesToTotals(totals, singleLiquidation);
            }
        }
    }

    // --- Liquidation helper functions ---

    function _addLiquidationValuesToTotals(LiquidationTotals memory oldTotals, LiquidationValues memory singleLiquidation)
    internal pure returns(LiquidationTotals memory newTotals) {

        // Tally all the values with their respective running totals
        newTotals.totalCollGasCompensation = oldTotals.totalCollGasCompensation.add(singleLiquidation.collGasCompensation);
        newTotals.totalDebtInSequence = oldTotals.totalDebtInSequence.add(singleLiquidation.entireTroveDebt);
        newTotals.totalCollInSequence = oldTotals.totalCollInSequence.add(singleLiquidation.entireTroveColl);
        newTotals.totalDebtToOffset = oldTotals.totalDebtToOffset.add(singleLiquidation.debtToOffset);
        newTotals.totalCollToSendToSP = oldTotals.totalCollToSendToSP.add(singleLiquidation.collToSendToSP);
        newTotals.totalDebtToRedistribute = oldTotals.totalDebtToRedistribute.add(singleLiquidation.debtToRedistribute);
        newTotals.totalCollToRedistribute = oldTotals.totalCollToRedistribute.add(singleLiquidation.collToRedistribute);
        newTotals.totalCollSurplus = oldTotals.totalCollSurplus.add(singleLiquidation.collSurplus);

        return newTotals;
    }

    function _sendGasCompensation(IActivePool _activePool, address _liquidator, uint _ETH) internal {
        if (_ETH > 0) {
            _activePool.sendETH(_liquidator, _ETH);
        }
    }

    // Move a Trove's pending debt and collateral rewards from distributions, from the Default Pool to the Active Pool
    function _movePendingTroveRewardsToActivePool(IActivePool _activePool, IDefaultPool _defaultPool, uint _debt, uint _ETH) internal {
        _defaultPool.decreaseLUSDDebt(_debt);
        _activePool.increaseLUSDDebt(_debt);
        _defaultPool.sendETHToActivePool(_ETH);
    }

    // --- Redemption functions ---

    /* Send _debtAmount debt token to the system and redeem the corresponding amount of collateral from all Troves.
    *  Redemption share snapshot update will be pending to all Troves for later apply.
    */
    function redeemCollateral(
        uint _debtAmount,
        uint _maxFeePercentage
    )
        external
        override
    {
        ContractsCache memory contractsCache = ContractsCache(
            activePool,
            defaultPool,
            debtToken,
            satoStaking,
            collSurplusPool
        );

        _requireValidMaxFeePercentage(_maxFeePercentage);
        _requireAfterBootstrapPeriod();
        uint _price = priceFeed.fetchPrice();
        _requireTCRoverMCR(_price);
        _requireAmountGreaterThanZero(_debtAmount);
        _requireDebtBalanceCoversRedemption(contractsCache.debtToken, msg.sender, _debtAmount);

        uint totalDebtSupplyAtStart = getEntireSystemDebt().sub(activePool.getRedeemedDebt());
        // Confirm redeemer's balance is less than total debt supply
        assert(contractsCache.debtToken.balanceOf(msg.sender) <= totalDebtSupplyAtStart);

        uint totalDebtToRedeem = _debtAmount;
        
        // update global redemption tracking snapshot
        uint totalCollDrawn = _updateRedemptionShare(totalDebtToRedeem, _price);

        // Decay the baseRate due to time passed, and then increase it according to the size of this redemption.
        // Use the saved total debt supply value, from before it was reduced by the redemption.
        _updateBaseRateFromRedemption(totalCollDrawn, _price, totalDebtSupplyAtStart);

        // Calculate the redemption fee
        uint redemptionFee = _getRedemptionFeeForRedeemer(msg.sender, totalCollDrawn);

        _requireUserAcceptsFee(redemptionFee, totalCollDrawn, _maxFeePercentage);
		
        // update totalCollateralSnapshot
        _updateSystemSnapshots_excludeCollRemainder(contractsCache.activePool, totalCollDrawn);

        // Send the ETH fee to the SATO staking contract
        contractsCache.activePool.sendETH(address(contractsCache.satoStaking), redemptionFee);
        contractsCache.satoStaking.increaseF_ETH(redemptionFee);

        uint collToRedeemer = totalCollDrawn.sub(redemptionFee);

        emit Redemption(_debtAmount, totalDebtToRedeem, totalCollDrawn, redemptionFee);

        // Transfer the total debt redeemed to Active Pool
        contractsCache.debtToken.transferFrom(msg.sender, address(contractsCache.activePool), totalDebtToRedeem);
        // Update Active Pool redemption debt tracker
        contractsCache.activePool.increaseRedemptionDebt(totalDebtToRedeem);
        // send the redeemed collateral to msg.sender
        contractsCache.activePool.sendETH(msg.sender, collToRedeemer);
    }

    // --- Helper functions ---

    // Return the current collateral ratio (ICR) of a given Trove. Takes a trove's pending coll and debt rewards from redistributions into account.
    function getCurrentICR(address _borrower, uint _price) public view override returns (uint) {
        (uint currentDebt, uint currentETH,,,,,) = getEntireDebtAndColl(_borrower);

        uint ICR = LiquityMath._computeCR(currentETH, currentDebt, _price);
        return ICR;
    }

    function applyPendingRewards(address _borrower) external override returns(bool){
        _requireCallerIsBorrowerOperations();
        return _applyPendingRewards(activePool, defaultPool, _borrower);
    }

    /// @dev Add the borrowers's coll and debt rewards earned from redistributions and redemption to their Trove
    /// @dev return true if the Trove is still active after applying otherwise return false
    function _applyPendingRewards(IActivePool _activePool, IDefaultPool _defaultPool, address _borrower) internal returns(bool){
        if (hasPendingRewards(_borrower) || hasPendingRedemptionShare(_borrower)) {
            _requireTroveIsActive(_borrower);

            // Compute pending rewards & redemption share
            (uint _debt, uint _coll, 
             uint pendingDebtReward, uint pendingETHReward, 
             uint pendingRedemptionDebt, uint pendingRedemptionColl, 
             uint pendingFreeDebt
            ) = getEntireDebtAndColl(_borrower);			 

            // Apply change to trove's state
            _updateTroveWithDistribution(_borrower, _debt, _coll, pendingDebtReward, pendingETHReward);	
            // Apply redemption accounting
            _applyRedemptionAccounting(_borrower, pendingRedemptionDebt, pendingFreeDebt);
			
            // Trove debt will be reduced due to redemption share
            if (_debt == 0){
                _scavengeTroveWithFreeDebt(_borrower, _borrower, pendingFreeDebt, priceFeed.fetchPrice());				
                return false;
            } else if (_debt > 0 && _debt < MIN_NET_DEBT){			
                require(pendingFreeDebt == 0, "TroveManager: non-zero free mint for Trove");
				
                uint _price = priceFeed.fetchPrice();	
                bool _liquidatable = _checkTroveLiquidatable(_price, _coll, _debt);
                if (!_liquidatable){
                    _scavengeTroveBelowMinimum(_borrower, _borrower, _price);			
                    return false;
                }		
            }
			
            _updateTroveRewardSnapshots(_borrower);
            _updateTroveRedemptionSnapshots(_borrower);

            emit TroveUpdated(
                _borrower,
                Troves[_borrower].debt,
                Troves[_borrower].coll,
                Troves[_borrower].stake,
                TroveManagerOperation.applyPendingRewards
            );
        }
        return true;
    }
	
    /// @dev close the Trove if debt reduced to zero by redemption
    function _scavengeTroveWithFreeDebt(address _scavenger, address _borrower, uint _freeDebt, uint _price) internal {
        require(Troves[_borrower].debt == 0, "TroveManager: only scavenge empty Trove with free mint");
		
        uint _reward = SCAVENGER_REWARD_DEBT.mul(DECIMAL_PRECISION).div(_price);
        (uint _collSurplus, uint _toScavengerCap) = _capScavengeReward(Troves[_borrower].coll, _reward);
        _reward = _toScavengerCap;
		
        // skip check on TCR for Recovery Mode trigger if close by scavenge		
        _removeStake(_borrower);
        _closeTrove(_borrower, Status.closedByRedemption);
		
        // move collateral surplus for owner
        _moveCollSurplusForTroveOwner(_scavenger, _borrower, _collSurplus);
		
        // reward scavenger
        activePool.sendETH(_scavenger, _reward);
		
        emit ScavengeFreeDebt(_borrower, _scavenger, _freeDebt, _collSurplus, _reward);
    }
	
    /// @dev Try to close the Trove if debt reduced to below minimum due to redemption
    function _scavengeTroveBelowMinimum(address _scavenger, address _borrower, uint _price) internal{
	
        uint _troveDebt = Troves[_borrower].debt;
		
        require(_troveDebt < MIN_NET_DEBT, "TroveManager: only scavenge Trove with debt below minimum");
        require(_troveDebt > 0, "TroveManager: Trove's debt is already zero");
		
        uint _collToScavenger = _troveDebt.mul(MCR).div(_price);
        (uint _collSurplus, uint _toScavengerCap) = _capScavengeReward(Troves[_borrower].coll, _collToScavenger);
        _collToScavenger = _toScavengerCap;
		
        // skip check on TCR for Recovery Mode trigger if close by scavenge
        _removeStake(_borrower);
        _closeTrove(_borrower, Status.closedByRedemption);
		
        // burn Trove's debt from scavenger
        activePool.decreaseLUSDDebt(_troveDebt);
        debtToken.burn(_scavenger, _troveDebt);
		
        // move collateral surplus for owner
        _moveCollSurplusForTroveOwner(_scavenger, _borrower, _collSurplus);
		
        // send deserved collateral to scavenger
        activePool.sendETH(_scavenger, _collToScavenger);
		
        emit ScavengeBelowMinimum(_borrower, _scavenger, _collSurplus, _collToScavenger, _troveDebt);
    }
	
	/// @dev This is to help to clean-up Trove that falls below minimum debt requirement due to redemption share
    function scavengeTrove(address _borrower) external override {
        _requireTroveIsActive(_borrower);

        // Compute pending rewards & redemption share
        (uint _debt, uint _coll, 
         uint pendingDebtReward, uint pendingCollReward, 
         uint pendingRedemptionDebt, uint pendingRedemptionColl, 
         uint pendingFreeDebt
        ) = getEntireDebtAndColl(_borrower);
		
        if (_debt == 0){
            _updateTroveWithDistribution(_borrower, _debt, _coll, pendingDebtReward, pendingCollReward);
            _applyRedemptionAccounting(_borrower, pendingRedemptionDebt, pendingFreeDebt);
            _scavengeTroveWithFreeDebt(msg.sender, _borrower, pendingFreeDebt, priceFeed.fetchPrice());
        } else if (_debt > 0 && _debt < MIN_NET_DEBT){            
            uint _price = priceFeed.fetchPrice();	
            bool _liquidatable = _checkTroveLiquidatable(_price, _coll, _debt);
            if (!_liquidatable){
                _updateTroveWithDistribution(_borrower, _debt, _coll, pendingDebtReward, pendingCollReward);
                _applyRedemptionAccounting(_borrower, pendingRedemptionDebt, pendingFreeDebt);
                _scavengeTroveBelowMinimum(msg.sender, _borrower, _price);	
            }
        }		
    }
	
    function _moveCollSurplusForTroveOwner(address _scavenger, address _borrower, uint256 _collSurplus) internal {
	
        if (_collSurplus > 0){
            if (_borrower == _scavenger){
                activePool.sendETH(_borrower, _collSurplus);			
            } else {
                collSurplusPool.accountSurplus(_borrower, _collSurplus);
                activePool.sendETH(address(collSurplusPool), _collSurplus);			
            }
        }
    }
	
    function _capScavengeReward(uint256 _troveColl, uint256 _toScavenger) internal returns (uint256, uint256) {
        bool _troveCollLarger = _troveColl > _toScavenger? true : false;
        uint _collSurplus = _troveCollLarger? (_troveColl.sub(_toScavenger)) : 0;
        uint256 _toScavengerCap = _troveCollLarger? _toScavenger : _troveColl;
        return (_collSurplus, _toScavengerCap);
    }	
	
    function _checkTroveLiquidatable(uint _price, uint _troveColl, uint _troveDebt) internal view returns (bool) {
        uint _tcr = _getTCR(_price);
        uint _icr = LiquityMath._computeCR(_troveColl, _troveDebt, _price);
        return _checkIfLiquidatableForTrove(_tcr, (_tcr < CCR? true : false), _icr);
    }	
	
    function _checkIfLiquidatableForTrove(uint _tcr, bool _inRecoverMode, uint _icr) internal view returns (bool) {
        if (_inRecoverMode){ // Recovery Mode
            if (_icr < _tcr || _icr < MCR) { 
                // eligible for liquidation
                return true;	
            }
        } else { // Normal Mode
            if (_icr < MCR) {
                // eligible for liquidation
                return true;
            } 
        }
        return false;
    }
	
    function _updateTroveWithDistribution(address _borrower, uint _newDebt, uint _newColl, uint pendingDebt, uint pendingColl) internal {			 

        // Apply change to trove's state
        Troves[_borrower].debt = _newDebt;
        Troves[_borrower].coll = _newColl;	
			
        // Transfer from DefaultPool to ActivePool
        if (pendingDebt > 0 || pendingColl > 0){
            _movePendingTroveRewardsToActivePool(activePool, defaultPool, pendingDebt, pendingColl);
        }	
    }
	
    function _applyRedemptionAccounting(address _borrower, uint256 _pendingDebtRedemption, uint256 _pendingFreeDebt) internal {
        if (_pendingDebtRedemption > 0){		
            // burn from Active Pool to reduce total supply
            // same debt amount will be reduced from _borrower's Trove (thus Active Pool global accouting)
            uint256 _debtToBurn = _pendingDebtRedemption;
            if (_pendingFreeDebt > 0){
                require(_pendingDebtRedemption > _pendingFreeDebt, "TroveManager: unapplied redemption debt should be larger");
                _debtToBurn = _pendingDebtRedemption.sub(_pendingFreeDebt);
            }		
            require(debtToken.balanceOf(address(activePool)) >= _debtToBurn, "TroveManager: not enough debt balance on Active Pool");
            activePool.decreaseLUSDDebt(_debtToBurn);
            debtToken.burn(address(activePool), _debtToBurn);
			
            // transfer due debt to borrower
            if (_pendingFreeDebt > 0){
                activePool.sendDebtFromRedemption(_borrower, _pendingFreeDebt);
            }
			
            // reduce redemption debt tracker in Active Pool
            activePool.decreaseRedemptionDebt(_pendingDebtRedemption);
        }	    
    }

    // Update borrower's snapshots of L_ETH and L_Debt to reflect the current values
    function updateTroveRewardSnapshots(address _borrower) external override {
        _requireCallerIsBorrowerOperations();
        return _updateTroveRewardSnapshots(_borrower);
    }

    // Update borrower's snapshots of R_Coll and R_Debt to reflect the current values
    function updateTroveRedemptionSnapshots(address _borrower) external override {
        _requireCallerIsBorrowerOperations();
        return _updateTroveRedemptionSnapshots(_borrower);
    }

    function _updateTroveRewardSnapshots(address _borrower) internal {
        rewardSnapshots[_borrower].ETH = L_ETH;
        rewardSnapshots[_borrower].Debt = L_LUSDDebt;
        emit TroveSnapshotsUpdated(L_ETH, L_LUSDDebt);
    }

    function _updateTroveRedemptionSnapshots(address _borrower) internal {
        redemptionSnapshots[_borrower].rColl = R_Coll;
        redemptionSnapshots[_borrower].rDebt = R_Debt;
        emit TroveRedemptionSnapshotsUpdated(_borrower, R_Coll, R_Debt);
    }

    // Get the borrower's pending accumulated collateral reward, earned by their stake
    function getPendingETHReward(address _borrower) public view override returns (uint) {
        uint snapshotETH = rewardSnapshots[_borrower].ETH;
        uint rewardPerUnitStaked = L_ETH.sub(snapshotETH);

        if ( rewardPerUnitStaked == 0 || Troves[_borrower].status != Status.active) { return 0; }

        uint stake = Troves[_borrower].stake;

        uint pendingETHReward = stake.mul(rewardPerUnitStaked).div(DECIMAL_PRECISION);

        return pendingETHReward;
    }

    // Get the borrower's pending accumulated collateral reduction from redemption, earned by their stake
    function getPendingCollRedemption(address _borrower) public view override returns (uint) {
        uint snapshotColl = redemptionSnapshots[_borrower].rColl;
        uint reductionPerUnitStaked = R_Coll.sub(snapshotColl);

        if ( reductionPerUnitStaked == 0 || Troves[_borrower].status != Status.active) { return 0; }

        uint stake = Troves[_borrower].stake;

        uint pendingReduction = stake.mul(reductionPerUnitStaked).div(DECIMAL_PRECISION);

        return pendingReduction;
    }
    
    // Get the borrower's pending accumulated debt reward, earned by their stake
    function getPendingLUSDDebtReward(address _borrower) public view override returns (uint) {
        uint snapshotDebt = rewardSnapshots[_borrower].Debt;
        uint rewardPerUnitStaked = L_LUSDDebt.sub(snapshotDebt);

        if ( rewardPerUnitStaked == 0 || Troves[_borrower].status != Status.active) { return 0; }

        uint stake =  Troves[_borrower].stake;

        uint pendingDebtReward = stake.mul(rewardPerUnitStaked).div(DECIMAL_PRECISION);

        return pendingDebtReward;
    }
    
    // Get the borrower's pending accumulated debt reduction from redemption, earned by their stake
    function getPendingDebtRedemption(address _borrower) public view override returns (uint) {
        uint snapshotDebt = redemptionSnapshots[_borrower].rDebt;
        uint reductionPerUnitStaked = R_Debt.sub(snapshotDebt);

        if ( reductionPerUnitStaked == 0 || Troves[_borrower].status != Status.active) { return 0; }

        uint stake =  Troves[_borrower].stake;

        uint pendingReduction = stake.mul(reductionPerUnitStaked).div(DECIMAL_PRECISION);

        return pendingReduction;
    }

    function hasPendingRewards(address _borrower) public view override returns (bool) {
        /*
        * A Trove has pending rewards if its snapshot is less than the current rewards per-unit-staked sum:
        * this indicates that rewards have occured since the snapshot was made, and the user therefore has
        * pending rewards
        */
        if (Troves[_borrower].status != Status.active) {return false;}
       
        return (rewardSnapshots[_borrower].ETH < L_ETH);
    }

    function hasPendingRedemptionShare(address _borrower) public view override returns (bool) {
        /*
        * A Trove has pending redemption share if its snapshot is less than the current global per-unit-staked sum:
        * this indicates that redemption have occured since the snapshot was made, and the user therefore has
        * pending share
        */
        if (Troves[_borrower].status != Status.active) {return false;}
       
        return (redemptionSnapshots[_borrower].rColl < R_Coll);
    }

    // Return the Troves entire debt and coll, including pending rewards from redistributions.
    function getEntireDebtAndColl(
        address _borrower
    )
        public
        view
        override
        returns (uint debt, uint coll, uint pendingDebtReward, uint pendingETHReward, uint pendingRedemptionDebt, uint pendingRedemptionColl, uint pendingFreeDebt)
    {
        debt = Troves[_borrower].debt;
        coll = Troves[_borrower].coll;

        pendingDebtReward = getPendingLUSDDebtReward(_borrower);
        pendingETHReward = getPendingETHReward(_borrower);

        pendingRedemptionDebt = getPendingDebtRedemption(_borrower);
        pendingRedemptionColl = getPendingCollRedemption(_borrower);

        debt = debt.add(pendingDebtReward);
        coll = coll.add(pendingETHReward).sub(pendingRedemptionColl);
		
        if (debt > pendingRedemptionDebt){
            debt = debt.sub(pendingRedemptionDebt);
        } else {
            pendingFreeDebt = pendingRedemptionDebt - debt;
            debt = 0;
        }
    }

    function removeStake(address _borrower) external override {
        _requireCallerIsBorrowerOperations();
        return _removeStake(_borrower);
    }

    // Remove borrower's stake from the totalStakes sum, and set their stake to 0
    function _removeStake(address _borrower) internal {
        uint stake = Troves[_borrower].stake;
        totalStakes = totalStakes.sub(stake);
        Troves[_borrower].stake = 0;
    }

    function updateStakeAndTotalStakes(address _borrower) external override returns (uint) {
        _requireCallerIsBorrowerOperations();
        return _updateStakeAndTotalStakes(_borrower);
    }

    // Update borrower's stake based on their latest collateral value
    function _updateStakeAndTotalStakes(address _borrower) internal returns (uint) {
        uint newStake = _computeNewStake(Troves[_borrower].coll);
        uint oldStake = Troves[_borrower].stake;
        Troves[_borrower].stake = newStake;

        totalStakes = totalStakes.sub(oldStake).add(newStake);
        emit TotalStakesUpdated(totalStakes);

        return newStake;
    }

    // Calculate a new stake based on the snapshots of the totalStakes and totalCollateral taken at the last liquidation
    function _computeNewStake(uint _coll) internal view returns (uint) {
        uint stake;
        if (totalCollateralSnapshot == 0) {
            stake = _coll;
        } else {
            /*
            * The following assert() holds true because:
            * - The system always contains >= 1 trove
            * - When we close or liquidate a trove, we redistribute the pending rewards, so if all troves were closed/liquidated,
            * rewards would’ve been emptied and totalCollateralSnapshot would be zero too.
            */
            assert(totalStakesSnapshot > 0);
            stake = _coll.mul(totalStakesSnapshot).div(totalCollateralSnapshot);
        }
        return stake;
    }

    function _redistributeDebtAndColl(IActivePool _activePool, IDefaultPool _defaultPool, uint _debt, uint _coll) internal {
        if (_debt == 0) { return; }
        uint256 _totalStakesCached = totalStakes;
        /*
        * Add distributed coll and debt rewards-per-unit-staked to the running totals. Division uses a "feedback"
        * error correction, to keep the cumulative error low in the running totals L_ETH and L_Debt:
        *
        * 1) Form numerators which compensate for the floor division errors that occurred the last time this
        * function was called.
        * 2) Calculate "per-unit-staked" ratios.
        * 3) Multiply each ratio back by its denominator, to reveal the current floor division error.
        * 4) Store these errors for use in the next correction when this function is called.
        * 5) Note: static analysis tools complain about this "division before multiplication", however, it is intended.
        */
        uint ETHNumerator = _coll.mul(DECIMAL_PRECISION).add(lastETHError_Redistribution);
        uint debtNumerator = _debt.mul(DECIMAL_PRECISION).add(lastLUSDDebtError_Redistribution);

        // Get the per-unit-staked terms
        uint ETHRewardPerUnitStaked = ETHNumerator.div(_totalStakesCached);
        uint dDebtRewardPerUnitStaked = debtNumerator.div(_totalStakesCached);

        lastETHError_Redistribution = ETHNumerator.sub(ETHRewardPerUnitStaked.mul(_totalStakesCached));
        lastLUSDDebtError_Redistribution = debtNumerator.sub(dDebtRewardPerUnitStaked.mul(_totalStakesCached));

        // Add per-unit-staked terms to the running totals
        L_ETH = L_ETH.add(ETHRewardPerUnitStaked);
        L_LUSDDebt = L_LUSDDebt.add(dDebtRewardPerUnitStaked);

        emit LTermsUpdated(L_ETH, L_LUSDDebt);

        // Transfer coll and debt from ActivePool to DefaultPool
        _activePool.decreaseLUSDDebt(_debt);
        _defaultPool.increaseLUSDDebt(_debt);
        _activePool.sendETH(address(_defaultPool), _coll);
    }

    function _updateRedemptionShare(uint _debt, uint _price) internal returns(uint256){
        if (_debt == 0) { return 0; }
        uint256 _totalStakesCached = totalStakes;
		
        uint256 _collToShare = _debt.mul(DECIMAL_PRECISION).div(_price);
		
        uint collNumerator = _collToShare.mul(DECIMAL_PRECISION).add(lastCollError_RedemptionShare);
        uint debtNumerator = _debt.mul(DECIMAL_PRECISION).add(lastDebtError_RedemptionShare);

        // Get the per-unit-staked terms
        uint collRewardPerUnitStaked = collNumerator.div(_totalStakesCached);
        uint debtRewardPerUnitStaked = debtNumerator.div(_totalStakesCached);

        lastCollError_RedemptionShare = collNumerator.sub(collRewardPerUnitStaked.mul(_totalStakesCached));
        lastDebtError_RedemptionShare = debtNumerator.sub(debtRewardPerUnitStaked.mul(_totalStakesCached));

        // Add per-unit-staked terms to the running totals
        R_Coll = R_Coll.add(collRewardPerUnitStaked);
        R_Debt = R_Debt.add(debtRewardPerUnitStaked);

        emit RTermsUpdated(R_Coll, R_Debt);
        return _collToShare;
    }

    function closeTrove(address _borrower) external override {
        _requireCallerIsBorrowerOperations();
        return _closeTrove(_borrower, Status.closedByOwner);
    }

    function _closeTrove(address _borrower, Status closedStatus) internal {
        assert(closedStatus != Status.nonExistent && closedStatus != Status.active);

        uint TroveOwnersArrayLength = TroveOwners.length;
        _requireMoreThanOneTroveInSystem(TroveOwnersArrayLength);

        Troves[_borrower].status = closedStatus;
        Troves[_borrower].coll = 0;
        Troves[_borrower].debt = 0;

        rewardSnapshots[_borrower].ETH = 0;
        rewardSnapshots[_borrower].Debt = 0;

        _removeTroveOwner(_borrower, TroveOwnersArrayLength);
    }

    /*
    * Updates snapshots of system total stakes and total collateral, excluding a given collateral remainder from the calculation.
    * Used in a liquidation sequence.
    *
    * The calculation excludes a portion of collateral that is in the ActivePool:
    *
    * the total ETH gas compensation from the liquidation sequence
    *
    * The ETH as compensation must be excluded as it is always sent out at the very end of the liquidation sequence.
    */
    function _updateSystemSnapshots_excludeCollRemainder(IActivePool _activePool, uint _collRemainder) internal {
        totalStakesSnapshot = totalStakes;

        uint activeColl = _activePool.getETH();
        uint liquidatedColl = defaultPool.getETH();
        totalCollateralSnapshot = activeColl.sub(_collRemainder).add(liquidatedColl);

        emit SystemSnapshotsUpdated(totalStakesSnapshot, totalCollateralSnapshot);
    }

    // Push the owner's address to the Trove owners list, and record the corresponding array index on the Trove struct
    function addTroveOwnerToArray(address _borrower) external override returns (uint index) {
        _requireCallerIsBorrowerOperations();
        return _addTroveOwnerToArray(_borrower);
    }

    function _addTroveOwnerToArray(address _borrower) internal returns (uint128 index) {
        // Max array size is 2**128 - 1, i.e. ~3e30 troves. No risk of overflow, since troves have minimum MIN_NET_DEBT. 
        // 3e30 debt token dwarfs the value of all wealth in the world ( which is < 1e15 USD). 

        // Push the Troveowner to the array
        TroveOwners.push(_borrower);

        // Record the index of the new Troveowner on their Trove struct
        index = uint128(TroveOwners.length.sub(1));
        Troves[_borrower].arrayIndex = index;

        return index;
    }

    /*
    * Remove a Trove owner from the TroveOwners array, not preserving array order. Removing owner 'B' does the following:
    * [A B C D E] => [A E C D], and updates E's Trove struct to point to its new array index.
    */
    function _removeTroveOwner(address _borrower, uint TroveOwnersArrayLength) internal {
        Status troveStatus = Troves[_borrower].status;
        // It’s set in caller function `_closeTrove`
        assert(troveStatus != Status.nonExistent && troveStatus != Status.active);

        uint128 index = Troves[_borrower].arrayIndex;
        uint length = TroveOwnersArrayLength;
        uint idxLast = length.sub(1);

        assert(index <= idxLast);

        address addressToMove = TroveOwners[idxLast];

        TroveOwners[index] = addressToMove;
        Troves[addressToMove].arrayIndex = index;
        emit TroveIndexUpdated(addressToMove, index);

        TroveOwners.pop();
    }

    // --- Recovery Mode and TCR functions ---

    function getTCR(uint _price) external view override returns (uint) {
        return _getTCR(_price);
    }

    function checkRecoveryMode(uint _price) external view override returns (bool) {
        return _checkRecoveryMode(_price);
    }

    // Check whether or not the system *would be* in Recovery Mode, given an ETH:USD price, and the entire system coll and debt.
    function _checkPotentialRecoveryMode(
        uint _entireSystemColl,
        uint _entireSystemDebt,
        uint _price
    )
        internal
        pure
    returns (bool)
    {
        uint TCR = LiquityMath._computeCR(_entireSystemColl, _entireSystemDebt, _price);

        return TCR < CCR;
    }

    // --- Redemption fee functions ---

    /*
    * This function has two impacts on the baseRate state variable:
    * 1) decays the baseRate based on time passed since last redemption or debt borrowing operation.
    * then,
    * 2) increases the baseRate based on the amount redeemed, as a proportion of total supply
    */
    function _updateBaseRateFromRedemption(uint _ETHDrawn,  uint _price, uint _totalDebtSupply) internal returns (uint) {
        uint newBaseRate = getUpdatedRedemptionBaseRate(_ETHDrawn, _price, _totalDebtSupply);
		
        assert(newBaseRate > 0); // Base rate is always non-zero after redemption

        // Update the baseRate state variable
        baseRate = newBaseRate;
        emit BaseRateUpdated(newBaseRate);
        
        _updateLastFeeOpTime();

        return newBaseRate;
    }
	
    function getUpdatedRedemptionBaseRate(uint _collDrawn, uint _price, uint _debtTotalSupply) public override view returns (uint){
        uint decayedBaseRate = _calcDecayedBaseRate();

        /* Convert the drawn collateral back to debt at face value rate (1 debt:1 USD), in order to get
        * the fraction of total supply that was redeemed at face value. */
        uint redeemedDebtFraction = _collDrawn.mul(_price).div(_debtTotalSupply);

        uint newBaseRate = decayedBaseRate.add(redeemedDebtFraction.div(BETA));
        newBaseRate = LiquityMath._min(newBaseRate, DECIMAL_PRECISION); // cap baseRate at a maximum of 100%
        return newBaseRate;
    }

    function getRedemptionRateForRedeemer(address _redeemer) public override view returns (uint) {
        bool _premiumRedeemer = satoStaking.ifPremiumStaking(_redeemer);
        return _calcRateWithFloor((_premiumRedeemer? REDEMPTION_FEE_FLOOR_PREMIUM : REDEMPTION_FEE_FLOOR), baseRate, false);
    }

    function getRedemptionRateWithDecayForRedeemer(address _redeemer) public view override returns (uint) {
        bool _premiumRedeemer = satoStaking.ifPremiumStaking(_redeemer);
        uint _decayedBaseRate = _calcDecayedBaseRate();
        return _calcRateWithFloor((_premiumRedeemer? REDEMPTION_FEE_FLOOR_PREMIUM : REDEMPTION_FEE_FLOOR), _decayedBaseRate, false);
    }

    function _getRedemptionFeeForRedeemer(address _redeemer, uint _ETHDrawn) internal view returns (uint) {
        uint _redemptionRate = getRedemptionRateForRedeemer(_redeemer);
        return _calcRedemptionFee(_redemptionRate, _ETHDrawn);
    }
	
    function getRedemptionFeeWithDecayForRedeemer(address _redeemer, uint _collDrawn) external override view returns (uint){
        uint256 _redemptionRate = getRedemptionRateWithDecayForRedeemer(_redeemer);
        return _calcRedemptionFee(_redemptionRate, _collDrawn);
    }

    function _calcRedemptionFee(uint _redemptionRate, uint _ETHDrawn) internal pure returns (uint) {
        uint redemptionFee = _redemptionRate.mul(_ETHDrawn).div(DECIMAL_PRECISION);
        require(redemptionFee < _ETHDrawn, "TroveManager: Fee would eat up all returned collateral");
        return redemptionFee;
    }

    // --- Borrowing fee functions ---

    function getBorrowingRateForBorrower(address _borrower) public view override returns (uint) {
        bool _premiumBorrower = satoStaking.ifPremiumStaking(_borrower);
        return _calcRateWithFloor((_premiumBorrower? BORROWING_FEE_FLOOR_PREMIUM : BORROWING_FEE_FLOOR), baseRate, true);
    }

    function getBorrowingRateWithDecayForBorrower(address _borrower) public view override returns (uint) {
        uint _decayedBaseRate = _calcDecayedBaseRate();
        bool _premiumBorrower = satoStaking.ifPremiumStaking(_borrower);
        return _calcRateWithFloor((_premiumBorrower? BORROWING_FEE_FLOOR_PREMIUM : BORROWING_FEE_FLOOR), _decayedBaseRate, true);
    }

    function _calcRateWithFloor(uint _feeFloor, uint _baseRate, bool _borrowing) internal pure returns (uint) {
        return LiquityMath._min(
            _feeFloor.add(_baseRate),
            (_borrowing? MAX_BORROWING_FEE : DECIMAL_PRECISION)
        );
    }

    function getBorrowingFeeForBorrower(address _borrower, uint _debt) external view override returns (uint) {
        uint256 _borrowingRate = getBorrowingRateForBorrower(_borrower);
        return _calcBorrowingFee(_borrowingRate, _debt);
    }

    function getBorrowingFeeWithDecayForBorrower(address _borrower, uint _debt) external view override returns (uint) {
        uint256 _borrowingRate = getBorrowingRateWithDecayForBorrower(_borrower);
        return _calcBorrowingFee(_borrowingRate, _debt);
    }

    function _calcBorrowingFee(uint _borrowingRate, uint _debt) internal pure returns (uint) {
        return _borrowingRate.mul(_debt).div(DECIMAL_PRECISION);
    }


    // Updates the baseRate state variable based on time elapsed since the last redemption or debt borrowing operation.
    function decayBaseRateFromBorrowing() external override {
        _requireCallerIsBorrowerOperations();
		
        uint decayedBaseRate = _calcDecayedBaseRate();
        assert(decayedBaseRate <= DECIMAL_PRECISION);  // The baseRate can decay to 0

        baseRate = decayedBaseRate;
        emit BaseRateUpdated(decayedBaseRate);

        _updateLastFeeOpTime();
    }

    // --- Internal fee functions ---

    // Update the last fee operation time only if time passed >= decay interval. This prevents base rate griefing.
    function _updateLastFeeOpTime() internal {
        uint timePassed = block.timestamp.sub(lastFeeOperationTime);

        if (timePassed >= SECONDS_IN_ONE_MINUTE) {
            lastFeeOperationTime = block.timestamp;
            emit LastFeeOpTimeUpdated(block.timestamp);
        }
    }

    function _calcDecayedBaseRate() internal view returns (uint) {
        uint minutesPassed = _minutesPassedSinceLastFeeOp();
        uint decayFactor = LiquityMath._decPow(MINUTE_DECAY_FACTOR, minutesPassed);

        return baseRate.mul(decayFactor).div(DECIMAL_PRECISION);
    }

    function _minutesPassedSinceLastFeeOp() internal view returns (uint) {
        return (block.timestamp.sub(lastFeeOperationTime)).div(SECONDS_IN_ONE_MINUTE);
    }

    // --- 'require' wrapper functions ---

    function _requireCallerIsBorrowerOperations() internal view {
        require(msg.sender == borrowerOperationsAddress, "TroveManager: Caller is not the BorrowerOperations contract");
    }

    function _requireTroveIsActive(address _borrower) internal view {
        require(Troves[_borrower].status == Status.active, "TroveManager: Trove does not exist or is closed");
    }

    function _requireDebtBalanceCoversRedemption(IBTUSDToken _debtToken, address _redeemer, uint _amount) internal view {
        require(_debtToken.balanceOf(_redeemer) >= _amount, "TroveManager: Requested redemption amount must be <= user's debt token balance");
    }

    function _requireMoreThanOneTroveInSystem(uint TroveOwnersArrayLength) internal view {
        require (TroveOwnersArrayLength > 1, "TroveManager: Only one trove in the system");
    }

    function _requireAmountGreaterThanZero(uint _amount) internal pure {
        require(_amount > 0, "TroveManager: Amount must be greater than zero");
    }

    function _requireTCRoverMCR(uint _price) internal view {
        require(_getTCR(_price) >= MCR, "TroveManager: Cannot redeem when TCR < MCR");
    }

    function _requireAfterBootstrapPeriod() internal view {
        uint systemDeploymentTime = satoToken.getDeploymentStartTime();
        require(block.timestamp >= systemDeploymentTime.add(BOOTSTRAP_PERIOD), "TroveManager: Redemptions are not allowed during bootstrap phase");
    }

    function _requireValidMaxFeePercentage(uint _maxFeePercentage) internal pure {
        require(_maxFeePercentage >= REDEMPTION_FEE_FLOOR && _maxFeePercentage <= DECIMAL_PRECISION,
            "Max fee percentage must be between 0.5% and 100%");
    }

    // --- Trove property getters ---

    function getTroveStatus(address _borrower) external view override returns (uint) {
        return uint(Troves[_borrower].status);
    }

    function getTroveStake(address _borrower) external view override returns (uint) {
        return Troves[_borrower].stake;
    }

    function getTroveDebt(address _borrower) external view override returns (uint) {
        return Troves[_borrower].debt;
    }

    function getTroveColl(address _borrower) external view override returns (uint) {
        return Troves[_borrower].coll;
    }

    // --- Trove property setters, called by BorrowerOperations ---

    function setTroveStatus(address _borrower, uint _num) external override {
        _requireCallerIsBorrowerOperations();
        Troves[_borrower].status = Status(_num);
    }

    function increaseTroveColl(address _borrower, uint _collIncrease) external override returns (uint) {
        _requireCallerIsBorrowerOperations();
        uint newColl = Troves[_borrower].coll.add(_collIncrease);
        Troves[_borrower].coll = newColl;
        return newColl;
    }

    function decreaseTroveColl(address _borrower, uint _collDecrease) external override returns (uint) {
        _requireCallerIsBorrowerOperations();
        uint newColl = Troves[_borrower].coll.sub(_collDecrease);
        Troves[_borrower].coll = newColl;
        return newColl;
    }

    function increaseTroveDebt(address _borrower, uint _debtIncrease) external override returns (uint) {
        _requireCallerIsBorrowerOperations();
        uint newDebt = Troves[_borrower].debt.add(_debtIncrease);
        Troves[_borrower].debt = newDebt;
        return newDebt;
    }

    function decreaseTroveDebt(address _borrower, uint _debtDecrease) external override returns (uint) {
        _requireCallerIsBorrowerOperations();
        uint newDebt = Troves[_borrower].debt.sub(_debtDecrease);
        Troves[_borrower].debt = newDebt;
        return newDebt;
    }
}

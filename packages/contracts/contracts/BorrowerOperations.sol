// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/IBorrowerOperations.sol";
import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IBTUSDToken.sol";
import "./Interfaces/ICollSurplusPool.sol";
import "./Interfaces/ISATOStaking.sol";
import "./Dependencies/LiquityBase.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/IERC20.sol";

contract BorrowerOperations is LiquityBase, Ownable, CheckContract, IBorrowerOperations {
    string constant public NAME = "BorrowerOperations";

    // --- Connected contract declarations ---

    ITroveManager public troveManager;

    address stabilityPoolAddress;

    ICollSurplusPool collSurplusPool;

    ISATOStaking public satoStaking;
    address public satoStakingAddress;

    IBTUSDToken public debtToken;
	
    IERC20 public collateral;

    /* --- Variable container structs  ---

    Used to hold, return and assign variables inside a function, in order to avoid the error:
    "CompilerError: Stack too deep". */

    struct LocalVariables_adjustTrove {
        uint price;
        uint collChange;
        uint netDebtChange;
        bool isCollIncrease;
        uint debt;
        uint coll;
        uint oldICR;
        uint newICR;
        uint newTCR;
        uint debtMintFee;
        uint newDebt;
        uint newColl;
        uint stake;
    }

    struct LocalVariables_openTrove {
        uint price;
        uint debtMintFee;
        uint netDebt;
        uint compositeDebt;
        uint ICR;
        uint NICR;
        uint stake;
        uint arrayIndex;
    }

    struct ContractsCache {
        ITroveManager troveManager;
        IActivePool activePool;
        IBTUSDToken debtToken;
    }

    enum BorrowerOperation {
        openTrove,
        closeTrove,
        adjustTrove,
        closeByApplyPendingChange
    }

    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _activePoolAddress);
    event DefaultPoolAddressChanged(address _defaultPoolAddress);
    event StabilityPoolAddressChanged(address _stabilityPoolAddress);
    event CollSurplusPoolAddressChanged(address _collSurplusPoolAddress);
    event PriceFeedAddressChanged(address  _newPriceFeedAddress);
    event BTUSDTokenAddressChanged(address _debtTokenAddress);
    event SATOStakingAddressChanged(address _satoStakingAddress);

    event TroveCreated(address indexed _borrower, uint arrayIndex);
    event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint stake, BorrowerOperation operation);
    event BTUSDBorrowingFeePaid(address indexed _borrower, uint _debtMintFee);
    
    // --- Dependency setters ---

    function setAddresses(
        address _troveManagerAddress,
        address _activePoolAddress,
        address _defaultPoolAddress,
        address _stabilityPoolAddress,
        address _collSurplusPoolAddress,
        address _priceFeedAddress,
        address _debtTokenAddress,
        address _satoStakingAddress,
        address _collAddress
    )
        external
        override
        onlyOwner
    {
        // This makes impossible to open a trove with zero withdrawn debt
        assert(MIN_NET_DEBT > 0);

        checkContract(_troveManagerAddress);
        checkContract(_activePoolAddress);
        checkContract(_defaultPoolAddress);
        checkContract(_stabilityPoolAddress);
        checkContract(_collSurplusPoolAddress);
        checkContract(_priceFeedAddress);
        checkContract(_debtTokenAddress);
        checkContract(_satoStakingAddress);
        checkContract(_collAddress);

        troveManager = ITroveManager(_troveManagerAddress);
        activePool = IActivePool(_activePoolAddress);
        defaultPool = IDefaultPool(_defaultPoolAddress);
        stabilityPoolAddress = _stabilityPoolAddress;
        collSurplusPool = ICollSurplusPool(_collSurplusPoolAddress);
        priceFeed = IPriceFeed(_priceFeedAddress);
        debtToken = IBTUSDToken(_debtTokenAddress);
        satoStakingAddress = _satoStakingAddress;
        satoStaking = ISATOStaking(_satoStakingAddress);
        collateral = IERC20(_collAddress);

        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);
        emit DefaultPoolAddressChanged(_defaultPoolAddress);
        emit StabilityPoolAddressChanged(_stabilityPoolAddress);
        emit CollSurplusPoolAddressChanged(_collSurplusPoolAddress);
        emit PriceFeedAddressChanged(_priceFeedAddress);
        emit BTUSDTokenAddressChanged(_debtTokenAddress);
        emit SATOStakingAddressChanged(_satoStakingAddress);

        _renounceOwnership();
    }

    // --- Borrower Trove Operations ---

    function openTrove(uint _maxFeePercentage, uint _debtAmount, uint _collAmt) external override {
        ContractsCache memory contractsCache = ContractsCache(troveManager, activePool, debtToken);
        LocalVariables_openTrove memory vars;

        vars.price = priceFeed.fetchPrice();
        bool isRecoveryMode = _checkRecoveryMode(vars.price);

        _requireValidMaxFeePercentage(_maxFeePercentage, isRecoveryMode);
        _requireTroveisNotActive(contractsCache.troveManager, msg.sender);

        vars.debtMintFee;
        vars.netDebt = _debtAmount;

        if (!isRecoveryMode) {
            vars.debtMintFee = _triggerBorrowingFee(msg.sender, contractsCache.troveManager, contractsCache.debtToken, _debtAmount, _maxFeePercentage);
            vars.netDebt = vars.netDebt.add(vars.debtMintFee);
        }
        _requireAtLeastMinNetDebt(vars.netDebt);

        // ICR is based on the composite debt, i.e. the requested debt amount + debt mint borrowing fee.
        vars.compositeDebt = vars.netDebt;
        assert(vars.compositeDebt > 0);
		
        require(collateral.transferFrom(msg.sender, address(this), _collAmt), "BorrowerOperations: transfer coll failed in openTrove");
        
        vars.ICR = LiquityMath._computeCR(_collAmt, vars.compositeDebt, vars.price);
        vars.NICR = LiquityMath._computeNominalCR(_collAmt, vars.compositeDebt);

        if (isRecoveryMode) {
            _requireICRisAboveCCR(vars.ICR);
        } else {
            _requireICRisAboveMCR(vars.ICR);
            uint newTCR = _getNewTCRFromTroveChange(_collAmt, true, vars.compositeDebt, true, vars.price);  // bools: coll increase, debt increase
            _requireNewTCRisAboveCCR(newTCR); 
        }

        // Set the trove struct's properties
        contractsCache.troveManager.setTroveStatus(msg.sender, 1);
        contractsCache.troveManager.increaseTroveColl(msg.sender, _collAmt);
        contractsCache.troveManager.increaseTroveDebt(msg.sender, vars.compositeDebt);

        contractsCache.troveManager.updateTroveRewardSnapshots(msg.sender);
        contractsCache.troveManager.updateTroveRedemptionSnapshots(msg.sender);
        vars.stake = contractsCache.troveManager.updateStakeAndTotalStakes(msg.sender);

        vars.arrayIndex = contractsCache.troveManager.addTroveOwnerToArray(msg.sender);
        emit TroveCreated(msg.sender, vars.arrayIndex);

        // Move the ether to the Active Pool, and mint the debt amount to the borrower
        _activePoolAddColl(contractsCache.activePool, _collAmt);
        _withdrawDebt(contractsCache.activePool, contractsCache.debtToken, msg.sender, _debtAmount, vars.netDebt);

        emit TroveUpdated(msg.sender, vars.compositeDebt, _collAmt, vars.stake, BorrowerOperation.openTrove);
        emit BTUSDBorrowingFeePaid(msg.sender, vars.debtMintFee);
    }

    // Send ETH as collateral to a trove
    function addColl(uint _collAmt) external override {
        _adjustTrove(msg.sender, _collAmt, true, 0, false, 0);
    }

    // Add collateral to a trove. Called by only the Stability Pool.
    function moveCollGainToTrove(address _borrower, uint _collAmt) external override {
        _requireCallerIsStabilityPool();
        _adjustTrove(_borrower, _collAmt, true, 0, false, 0);
    }

    // Withdraw ETH collateral from a trove
    function withdrawColl(uint _collWithdrawal) external override {
        _adjustTrove(msg.sender, _collWithdrawal, false, 0, false, 0);
    }

    // Withdraw debt tokens from a trove: mint new debt tokens to the owner, and increase the trove's debt accordingly
    function withdrawDebt(uint _maxFeePercentage, uint _debtAmount) external override {
        _adjustTrove(msg.sender, 0, false, _debtAmount, true, _maxFeePercentage);
    }

    // Repay debt tokens to a Trove: Burn the repaid debt tokens, and reduce the trove's debt accordingly
    function repayDebt(uint _debtAmount) external override {
        _adjustTrove(msg.sender, 0, false, _debtAmount, false, 0);
    }

    function adjustTrove(uint _maxFeePercentage, uint _collWithdrawal, bool _isCollIncrease, uint _debtChange, bool _isDebtIncrease) external override {
        _adjustTrove(msg.sender, _collWithdrawal, _isCollIncrease, _debtChange, _isDebtIncrease, _maxFeePercentage);
    }

    /*
    * _adjustTrove(): Alongside a debt change, this function can perform either a collateral top-up or a collateral withdrawal. 
    */
    function _adjustTrove(address _borrower, uint _collChange, bool _isCollIncrease, uint _debtChange, bool _isDebtIncrease, uint _maxFeePercentage) internal {
        ContractsCache memory contractsCache = ContractsCache(troveManager, activePool, debtToken);
        LocalVariables_adjustTrove memory vars;

        vars.price = priceFeed.fetchPrice();
        bool isRecoveryMode = _checkRecoveryMode(vars.price);

        if (_isDebtIncrease) {
            _requireValidMaxFeePercentage(_maxFeePercentage, isRecoveryMode);
            _requireNonZeroDebtChange(_debtChange);
        }
        _requireNonZeroAdjustment(_collChange, _debtChange);
        _requireTroveisActive(contractsCache.troveManager, _borrower);

        // Confirm the operation is either a borrower adjusting their own trove, or a pure collateral transfer from the Stability Pool to a trove
        require(msg.sender == _borrower || (msg.sender == stabilityPoolAddress && _collChange > 0 && _debtChange == 0), "BorrowerOperation: sender is not owner or SP");

        // sync Trove by applying pending share from both liquidation and redemption
        bool _troveActive = contractsCache.troveManager.applyPendingRewards(_borrower);		
        if (!_troveActive){
            emit TroveUpdated(_borrower, 0, 0, 0, BorrowerOperation.closeByApplyPendingChange);
            return;		    
        }
		
        if (_collChange > 0 && _isCollIncrease){
            require(collateral.transferFrom(msg.sender, address(this), _collChange), "BorrowerOperations: transfer coll failed in adjustTrove");		
        }

        vars.isCollIncrease = _isCollIncrease;
        vars.collChange = _collChange;

        vars.netDebtChange = _debtChange;

        // If the adjustment incorporates a debt increase and system is in Normal Mode, then trigger a borrowing fee
        if (_isDebtIncrease && !isRecoveryMode) { 
            vars.debtMintFee = _triggerBorrowingFee(_borrower, contractsCache.troveManager, contractsCache.debtToken, _debtChange, _maxFeePercentage);
            vars.netDebtChange = vars.netDebtChange.add(vars.debtMintFee); // The raw debt change includes the fee
        }

        vars.debt = contractsCache.troveManager.getTroveDebt(_borrower);
        vars.coll = contractsCache.troveManager.getTroveColl(_borrower);
        
        // Get the trove's old ICR before the adjustment, and what its new ICR will be after the adjustment
        vars.oldICR = LiquityMath._computeCR(vars.coll, vars.debt, vars.price);
        vars.newICR = _getNewICRFromTroveChange(vars.coll, vars.debt, vars.collChange, vars.isCollIncrease, vars.netDebtChange, _isDebtIncrease, vars.price);
        if (!vars.isCollIncrease){
            require(vars.collChange <= vars.coll, "BorrowerOperations: withdraw more coll than Trove holds"); 		
        }

        // Check the adjustment satisfies all conditions for the current system mode
        _requireValidAdjustmentInCurrentMode(isRecoveryMode, vars.isCollIncrease, vars.collChange, _isDebtIncrease, vars);
            
        // When the adjustment is a debt repayment, check it's a valid amount and that the caller has enough debt
        if (!_isDebtIncrease && _debtChange > 0) {
            _requireAtLeastMinNetDebt(vars.debt.sub(vars.netDebtChange));
            _requireValidDebtRepayment(vars.debt, vars.netDebtChange);
            _requireSufficientDebtBalance(contractsCache.debtToken, _borrower, vars.netDebtChange);
        }

        (vars.newColl, vars.newDebt) = _updateTroveFromAdjustment(contractsCache.troveManager, _borrower, vars.collChange, vars.isCollIncrease, vars.netDebtChange, _isDebtIncrease);
        vars.stake = contractsCache.troveManager.updateStakeAndTotalStakes(_borrower);

        emit TroveUpdated(_borrower, vars.newDebt, vars.newColl, vars.stake, BorrowerOperation.adjustTrove);
        emit BTUSDBorrowingFeePaid(msg.sender, vars.debtMintFee);

        // Use the unmodified _debtChange here, as we don't send the fee to the user
        _moveTokensAndCollfromAdjustment(
            contractsCache.activePool,
            contractsCache.debtToken,
            msg.sender,
            vars.collChange,
            vars.isCollIncrease,
            _debtChange,
            _isDebtIncrease,
            vars.netDebtChange
        );
    }

    function closeTrove() external override {
        ITroveManager troveManagerCached = troveManager;
        IActivePool activePoolCached = activePool;
        IBTUSDToken debtTokenCached = debtToken;

        _requireTroveisActive(troveManagerCached, msg.sender);
        uint price = priceFeed.fetchPrice();
        _requireNotInRecoveryMode(price);

        bool _troveActive = troveManagerCached.applyPendingRewards(msg.sender);
        if (!_troveActive){
            emit TroveUpdated(msg.sender, 0, 0, 0, BorrowerOperation.closeByApplyPendingChange);
            return;
        }

        uint coll = troveManagerCached.getTroveColl(msg.sender);
        uint debt = troveManagerCached.getTroveDebt(msg.sender);

        _requireSufficientDebtBalance(debtTokenCached, msg.sender, debt);

        uint newTCR = _getNewTCRFromTroveChange(coll, false, debt, false, price);
        _requireNewTCRisAboveCCR(newTCR);

        troveManagerCached.removeStake(msg.sender);
        troveManagerCached.closeTrove(msg.sender);

        emit TroveUpdated(msg.sender, 0, 0, 0, BorrowerOperation.closeTrove);

        // Burn the repaid debt from the user's balance
        _repayDebt(activePoolCached, debtTokenCached, msg.sender, debt);

        // Send the collateral back to the user
        activePoolCached.sendETH(msg.sender, coll);
    }

    /**
     * Claim remaining collateral from a redemption or from a liquidation with ICR > MCR in Recovery Mode
     */
    function claimCollateral() external override {
        // send ETH from CollSurplus Pool to owner
        collSurplusPool.claimColl(msg.sender);
    }

    // --- Helper functions ---

    function _triggerBorrowingFee(address _borrower, ITroveManager _troveManager, IBTUSDToken _debtToken, uint _debtAmount, uint _maxFeePercentage) internal returns (uint) {
        _troveManager.decayBaseRateFromBorrowing(); // decay the baseRate state variable
        uint debtMintFee = _troveManager.getBorrowingFeeForBorrower(_borrower, _debtAmount);

        _requireUserAcceptsFee(debtMintFee, _debtAmount, _maxFeePercentage);
        
        // Send fee to SATO staking contract
        satoStaking.increaseF_LUSD(debtMintFee);
        _debtToken.mint(satoStakingAddress, debtMintFee);

        return debtMintFee;
    }

    function _getUSDValue(uint _coll, uint _price) internal pure returns (uint) {
        uint usdValue = _price.mul(_coll).div(DECIMAL_PRECISION);

        return usdValue;
    }

    // Update trove's coll and debt based on whether they increase or decrease
    function _updateTroveFromAdjustment
    (
        ITroveManager _troveManager,
        address _borrower,
        uint _collChange,
        bool _isCollIncrease,
        uint _debtChange,
        bool _isDebtIncrease
    )
        internal
        returns (uint, uint)
    {
        uint newColl = (_isCollIncrease) ? _troveManager.increaseTroveColl(_borrower, _collChange)
                                        : _troveManager.decreaseTroveColl(_borrower, _collChange);
        uint newDebt = (_isDebtIncrease) ? _troveManager.increaseTroveDebt(_borrower, _debtChange)
                                        : _troveManager.decreaseTroveDebt(_borrower, _debtChange);

        return (newColl, newDebt);
    }

    function _moveTokensAndCollfromAdjustment
    (
        IActivePool _activePool,
        IBTUSDToken _debtToken,
        address _borrower,
        uint _collChange,
        bool _isCollIncrease,
        uint _debtChange,
        bool _isDebtIncrease,
        uint _netDebtChange
    )
        internal
    {
        if (_isDebtIncrease) {
            _withdrawDebt(_activePool, _debtToken, _borrower, _debtChange, _netDebtChange);
        } else {
            _repayDebt(_activePool, _debtToken, _borrower, _debtChange);
        }

        if (_isCollIncrease) {
            _activePoolAddColl(_activePool, _collChange);
        } else {
            _activePool.sendETH(_borrower, _collChange);
        }
    }

    // Send collateral to Active Pool and increase its recorded collateral balance
    function _activePoolAddColl(IActivePool _activePool, uint _amount) internal {
        require(collateral.transfer(address(_activePool), _amount), "BorrowerOps: Sending collateral to ActivePool failed");
        _activePool.receiveCollateral(_amount);		
    }

    // Issue the specified amount of debt to _account and increases the total active debt (_netDebtIncrease potentially includes a debt mint fee)
    function _withdrawDebt(IActivePool _activePool, IBTUSDToken _debtToken, address _account, uint _debtAmount, uint _netDebtIncrease) internal {
        _activePool.increaseLUSDDebt(_netDebtIncrease);
        _debtToken.mint(_account, _debtAmount);
    }

    // Burn the specified amount of debt from _account and decreases the total active debt
    function _repayDebt(IActivePool _activePool, IBTUSDToken _debtToken, address _account, uint _debt) internal {
        _activePool.decreaseLUSDDebt(_debt);
        _debtToken.burn(_account, _debt);
    }

    // --- 'Require' wrapper functions ---

    function _requireNonZeroAdjustment(uint _collChange, uint _debtChange) internal view {
        require(_collChange != 0 || _debtChange != 0, "BorrowerOps: There must be either a collateral change or a debt change");
    }

    function _requireTroveisActive(ITroveManager _troveManager, address _borrower) internal view {
        uint status = _troveManager.getTroveStatus(_borrower);
        require(status == 1, "BorrowerOps: Trove does not exist or is closed");
    }

    function _requireTroveisNotActive(ITroveManager _troveManager, address _borrower) internal view {
        uint status = _troveManager.getTroveStatus(_borrower);
        require(status != 1, "BorrowerOps: Trove is active");
    }

    function _requireNonZeroDebtChange(uint _debtChange) internal pure {
        require(_debtChange > 0, "BorrowerOps: Debt increase requires non-zero debtChange");
    }
   
    function _requireNotInRecoveryMode(uint _price) internal view {
        require(!_checkRecoveryMode(_price), "BorrowerOps: Operation not permitted during Recovery Mode");
    }

    function _requireNoCollWithdrawal(uint _collWithdrawal) internal pure {
        require(_collWithdrawal == 0, "BorrowerOps: Collateral withdrawal not permitted Recovery Mode");
    }

    function _requireValidAdjustmentInCurrentMode 
    (
        bool _isRecoveryMode,
        bool _isCollIncrease,
        uint _collChange,
        bool _isDebtIncrease, 
        LocalVariables_adjustTrove memory _vars
    ) 
        internal 
        view 
    {
        /* 
        *In Recovery Mode, only allow:
        *
        * - Pure collateral top-up
        * - Pure debt repayment
        * - Collateral top-up with debt repayment
        * - A debt increase combined with a collateral top-up which makes the ICR >= 150% and improves the ICR (and by extension improves the TCR).
        *
        * In Normal Mode, ensure:
        *
        * - The new ICR is above MCR
        * - The adjustment won't pull the TCR below CCR
        */
        if (_isRecoveryMode) {
            if (!_isCollIncrease){			
                _requireNoCollWithdrawal(_collChange);
            }
            if (_isDebtIncrease) {
                _requireICRisAboveCCR(_vars.newICR);
                _requireNewICRisAboveOldICR(_vars.newICR, _vars.oldICR);
            }       
        } else { // if Normal Mode
            _requireICRisAboveMCR(_vars.newICR);
            _vars.newTCR = _getNewTCRFromTroveChange(_vars.collChange, _vars.isCollIncrease, _vars.netDebtChange, _isDebtIncrease, _vars.price);
            _requireNewTCRisAboveCCR(_vars.newTCR);  
        }
    }

    function _requireICRisAboveMCR(uint _newICR) internal pure {
        require(_newICR >= MCR, "BorrowerOps: An operation that would result in ICR < MCR is not permitted");
    }

    function _requireICRisAboveCCR(uint _newICR) internal pure {
        require(_newICR >= CCR, "BorrowerOps: Operation must leave trove with ICR >= CCR");
    }

    function _requireNewICRisAboveOldICR(uint _newICR, uint _oldICR) internal pure {
        require(_newICR >= _oldICR, "BorrowerOps: Cannot decrease your Trove's ICR in Recovery Mode");
    }

    function _requireNewTCRisAboveCCR(uint _newTCR) internal pure {
        require(_newTCR >= CCR, "BorrowerOps: An operation that would result in TCR < CCR is not permitted");
    }

    function _requireAtLeastMinNetDebt(uint _netDebt) internal pure {
        require (_netDebt >= MIN_NET_DEBT, "BorrowerOps: Trove's net debt must be greater than minimum");
    }

    function _requireValidDebtRepayment(uint _currentDebt, uint _debtRepayment) internal pure {
        require(_debtRepayment <= _currentDebt, "BorrowerOps: Amount repaid must not be larger than the Trove's debt");
    }

    function _requireCallerIsStabilityPool() internal view {
        require(msg.sender == stabilityPoolAddress, "BorrowerOps: Caller is not Stability Pool");
    }

     function _requireSufficientDebtBalance(IBTUSDToken _debtToken, address _borrower, uint _debtRepayment) internal view {
        require(_debtToken.balanceOf(_borrower) >= _debtRepayment, "BorrowerOps: Caller doesnt have enough LUSD to make repayment");
    }

    function _requireValidMaxFeePercentage(uint _maxFeePercentage, bool _isRecoveryMode) internal pure {
        if (_isRecoveryMode) {
            require(_maxFeePercentage <= DECIMAL_PRECISION,
                "Max fee percentage must less than or equal to 100%");
        } else {
            require(_maxFeePercentage >= BORROWING_FEE_FLOOR && _maxFeePercentage <= DECIMAL_PRECISION,
                "Max fee percentage must be between 0.5% and 100%");
        }
    }

    // --- ICR and TCR getters ---

    // Compute the new collateral ratio, considering the change in coll and debt. Assumes 0 pending rewards.
    function _getNewICRFromTroveChange
    (
        uint _coll,
        uint _debt,
        uint _collChange,
        bool _isCollIncrease,
        uint _debtChange,
        bool _isDebtIncrease,
        uint _price
    )
        pure
        internal
        returns (uint)
    {
        (uint newColl, uint newDebt) = _getNewTroveAmounts(_coll, _debt, _collChange, _isCollIncrease, _debtChange, _isDebtIncrease);

        uint newICR = LiquityMath._computeCR(newColl, newDebt, _price);
        return newICR;
    }

    function _getNewTroveAmounts(
        uint _coll,
        uint _debt,
        uint _collChange,
        bool _isCollIncrease,
        uint _debtChange,
        bool _isDebtIncrease
    )
        internal
        pure
        returns (uint, uint)
    {
        uint newColl = _coll;
        uint newDebt = _debt;

        newColl = _isCollIncrease ? _coll.add(_collChange) :  _coll.sub(_collChange);
        newDebt = _isDebtIncrease ? _debt.add(_debtChange) : _debt.sub(_debtChange);

        return (newColl, newDebt);
    }

    function _getNewTCRFromTroveChange
    (
        uint _collChange,
        bool _isCollIncrease,
        uint _debtChange,
        bool _isDebtIncrease,
        uint _price
    )
        internal
        view
        returns (uint)
    {
        uint totalColl = getEntireSystemColl();
        uint totalDebt = getEntireSystemDebt();

        totalColl = _isCollIncrease ? totalColl.add(_collChange) : totalColl.sub(_collChange);
        totalDebt = _isDebtIncrease ? totalDebt.add(_debtChange) : totalDebt.sub(_debtChange);

        uint newTCR = LiquityMath._computeCR(totalColl, totalDebt.sub(activePool.getRedeemedDebt()), _price);
        return newTCR;
    }
}

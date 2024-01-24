// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import './Interfaces/IActivePool.sol';
import "./Dependencies/SafeMath.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/console.sol";
import "./Dependencies/IERC20.sol";
import './Interfaces/ICollSurplusPool.sol';
import './Interfaces/IDefaultPool.sol';
import './Interfaces/IStabilityPool.sol';
import "./Interfaces/IBTUSDToken.sol";
import "./Interfaces/ITroveManager.sol";
import "./Dependencies/IERC3156FlashLender.sol";
import "./Dependencies/IERC3156FlashBorrower.sol";
import "./Interfaces/ISATOStaking.sol";

/*
 * The Active Pool holds the collateral and debt accounting (possibly debt token from redemption as well) for all active troves.
 *
 * When a trove is liquidated, it's collateral and debt accounting are transferred from the Active Pool, to either the
 * Stability Pool, the Default Pool, or both, depending on the liquidation conditions.
 *
 */
contract ActivePool is Ownable, CheckContract, IActivePool, IERC3156FlashLender {
    using SafeMath for uint256;

    string constant public NAME = "ActivePool";

    address public borrowerOperationsAddress;
    address public troveManagerAddress;
    address public stabilityPoolAddress;
    address public defaultPoolAddress;
    address public collSurplusPoolAddress;
    uint256 internal systemCollateral;  // deposited collateral tracker
    uint256 internal BTUSDDebt;
    // keep track of accumulated debt from redemption but not applied to individual Trove yet
    uint256 internal redeemedDebt;
	
    IERC20 public collateral;
    IBTUSDToken public debtToken;

    ISATOStaking public satoStaking;	
	
    uint256 public constant MAX_BPS = 10_000;
    uint256 public constant FLASH_FEE_BPS = 8; // 0.08%
    bytes32 public constant FLASH_SUCCESS_VALUE = keccak256("ERC3156FlashBorrower.onFlashLoan");

    // --- Events ---

    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolBTUSDDebtUpdated(uint _debt);
    event ActivePoolETHBalanceUpdated(uint _systemCollateral);
    event ActivePoolRedeemedDebtUpdated(uint _redeemedDebt);
    event CollateralFlashloan(address indexed _borrower, uint256 _amount, uint256 _fee);

    // --- Contract setters ---

    function setAddresses(
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _stabilityPoolAddress,
        address _defaultPoolAddress,
        address _collSurplusPoolAddress,
        address _collAddress,
        address _debtTokenAddress,
        address _satoStakingAddress
    )
        external
        onlyOwner
    {
        checkContract(_borrowerOperationsAddress);
        checkContract(_troveManagerAddress);
        checkContract(_stabilityPoolAddress);
        checkContract(_defaultPoolAddress);
        checkContract(_collSurplusPoolAddress);
        checkContract(_collAddress);
        checkContract(_debtTokenAddress);
        checkContract(_satoStakingAddress);

        borrowerOperationsAddress = _borrowerOperationsAddress;
        troveManagerAddress = _troveManagerAddress;
        stabilityPoolAddress = _stabilityPoolAddress;
        defaultPoolAddress = _defaultPoolAddress;
        collSurplusPoolAddress = _collSurplusPoolAddress;
        collateral = IERC20(_collAddress);
        debtToken = IBTUSDToken(_debtTokenAddress);
        satoStaking = ISATOStaking(_satoStakingAddress);

        emit BorrowerOperationsAddressChanged(_borrowerOperationsAddress);
        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit StabilityPoolAddressChanged(_stabilityPoolAddress);
        emit DefaultPoolAddressChanged(_defaultPoolAddress);

        _renounceOwnership();
    }

    // --- Getters for public variables. Required by IPool interface ---

    /*
    * Returns the systemCollateral state variable.
    */
    function getETH() external view override returns (uint) {
        return systemCollateral;
    }

    function getLUSDDebt() external view override returns (uint) {
        return BTUSDDebt;
    }

    /// @dev return accumulated debt from redemption but not applied to individual Trove yet
    function getRedeemedDebt() external view override returns (uint) {
        return redeemedDebt;
    }

    // --- Pool functionality ---

    function sendETH(address _account, uint _amount) external override {
        _requireCallerIsBOorTroveMorSP();
        _sendCollateralOut(_account, _amount);
    }
	
    function _sendCollateralOut(address _account, uint _amount) internal {	
        systemCollateral = systemCollateral.sub(_amount);
        emit ActivePoolETHBalanceUpdated(systemCollateral);
        emit EtherSent(_account, _amount);

        require(collateral.transfer(_account, _amount), "ActivePool: sending collateral failed");
        if (_account == collSurplusPoolAddress){
            ICollSurplusPool(collSurplusPoolAddress).receiveCollateral(_amount);
        } else if (_account == defaultPoolAddress){
            IDefaultPool(defaultPoolAddress).receiveCollateral(_amount);
        } else if (_account == stabilityPoolAddress){
            IStabilityPool(stabilityPoolAddress).receiveCollateral(_amount);
        }
    }

    function increaseLUSDDebt(uint _amount) external override {
        _requireCallerIsBOorTroveM();
        BTUSDDebt = BTUSDDebt.add(_amount);
        emit ActivePoolBTUSDDebtUpdated(BTUSDDebt);
    }

    function decreaseLUSDDebt(uint _amount) external override {
        _requireCallerIsBOorTroveMorSP();
        BTUSDDebt = BTUSDDebt.sub(_amount);
        emit ActivePoolBTUSDDebtUpdated(BTUSDDebt);
    }

    /// @dev called by TroveManager.redeemCollateral
    function increaseRedemptionDebt(uint _amount) external override {
        _requireCallerIsTroveManager();
        redeemedDebt = redeemedDebt.add(_amount);
        emit ActivePoolRedeemedDebtUpdated(redeemedDebt);
    }

	/// @dev called by TroveManager whenever there is pending change applied to a trove
    function decreaseRedemptionDebt(uint _amount) external override {
        _requireCallerIsTroveManager();
        redeemedDebt = redeemedDebt.sub(_amount);
        emit ActivePoolRedeemedDebtUpdated(redeemedDebt);
    }
	
	/// @dev called by TroveManager during trove scavenge
    function sendDebtFromRedemption(address _borrower, uint256 _amount) external override {
        _requireCallerIsTroveManager();
        require(redeemedDebt >= _amount, "ActivePool: not enough debt from redemption");
        require(ITroveManager(troveManagerAddress).getTroveDebt(_borrower) == 0, "ActivePool: only send due debt to zero-debt Trove");
        require(ITroveManager(troveManagerAddress).getTroveStatus(_borrower) == 1, "ActivePool: only send due debt to active Trove (to be closed)");
        require(debtToken.transfer(_borrower, _amount), "ActivePool: sending debt from redemption failed");		
    }

    // === Flashloans === //

    /// @notice Borrow collateral with a flashloan
    /// @param receiver The address to receive the flashloan
    /// @param token The address of the token to loan, must be supported collateral
    /// @param amount The amount of tokens to loan
    /// @param data Additional data
    /// @return A boolean value indicating whether the flashloan was successful
    function flashLoan(
        IERC3156FlashBorrower receiver,
        address token,
        uint256 amount,
        bytes calldata data
    ) external override returns (bool) {
        require(amount > 0, "ActivePool: Zero amount for flashloan");
        uint256 fee = flashFee(token, amount);
        uint256 _maxFlashloanAllowed = maxFlashLoan(token);
        require(amount <= _maxFlashloanAllowed, "ActivePool: Too much asked for flashloan");
		
        require(
            _maxFlashloanAllowed >= systemCollateral,
            "ActivePool: Flashloan not allowed if system collateral accouting is wrong"
        );

        uint256 amountWithFee = amount.add(fee);

        IERC20 _collateralCached = collateral;
        require(_collateralCached.transfer(address(receiver), amount), "ActivePool: failed to transfer collateral to receiver");

        // Callback
        require(
            receiver.onFlashLoan(msg.sender, token, amount, fee, data) == FLASH_SUCCESS_VALUE,
            "ActivePool: IERC3156 callback on receiver failed"
        );

        // Transfer of (principal + Fee) from flashloan receiver
        require(_collateralCached.transferFrom(address(receiver), address(this), amount), "ActivePool: failed to transfer principal from flashloan receiver");
        require(_collateralCached.transferFrom(address(receiver), address(satoStaking), fee), "ActivePool: sending flashloan fee failed");
		
        // make accouting of flashloan fee to SATO Staking pool
        satoStaking.increaseF_ETH(fee);
		
        require(
            _collateralCached.balanceOf(address(this)) >= systemCollateral,
            "ActivePool: Receiver must repay flashloan in full amount"
        );

        emit CollateralFlashloan(address(receiver), amount, fee);

        return true;
    }

    /// @notice Calculate the flash loan fee for a given token and amount loaned
    /// @param token The address of the token to calculate the fee for
    /// @param amount The amount of tokens to calculate the fee for
    /// @return The flashloan fee calcualted for given token and loan amount
    function flashFee(address token, uint256 amount) public view override returns (uint256) {
        require(token == address(collateral), "ActivePool: collateral Only");
        return amount.mul(FLASH_FEE_BPS).div(MAX_BPS);
    }

    /// @notice Get the maximum flash loan amount for a specific token
    /// @dev only for supported collateral, equal to the current balance of the pool
    /// @param token The address of the token to get the maximum flash loan amount for
    /// @return The maximum available flashloan amount for the token
    function maxFlashLoan(address token) public view override returns (uint256) {
        if (token != address(collateral)) {
            return 0;
        }
        return collateral.balanceOf(address(this));
    }

    // --- 'require' functions ---

    function _requireCallerIsTroveManager() internal view {
        require(msg.sender == troveManagerAddress, "ActivePool: Caller is not TroveManager");
    }

    function _requireCallerIsBorrowerOperationsOrDefaultPool() internal view {
        require(
            msg.sender == borrowerOperationsAddress ||
            msg.sender == defaultPoolAddress,
            "ActivePool: Caller is neither BO nor Default Pool");
    }

    function _requireCallerIsBOorTroveMorSP() internal view {
        require(
            msg.sender == borrowerOperationsAddress ||
            msg.sender == troveManagerAddress ||
            msg.sender == stabilityPoolAddress,
            "ActivePool: Caller is neither BorrowerOperations nor TroveManager nor StabilityPool");
    }

    function _requireCallerIsBOorTroveM() internal view {
        require(
            msg.sender == borrowerOperationsAddress ||
            msg.sender == troveManagerAddress,
            "ActivePool: Caller is neither BorrowerOperations nor TroveManager");
    }

    /// @dev increase system collateral accouting by _amount
    function receiveCollateral(uint256 _amount) external override {
        _requireCallerIsBorrowerOperationsOrDefaultPool();
        systemCollateral = systemCollateral.add(_amount);
        emit ActivePoolETHBalanceUpdated(systemCollateral);
    }
}

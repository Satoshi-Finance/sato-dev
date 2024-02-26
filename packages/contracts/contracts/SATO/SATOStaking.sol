// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/BaseMath.sol";
import "../Dependencies/SafeMath.sol";
import "../Dependencies/Ownable.sol";
import "../Dependencies/CheckContract.sol";
import "../Dependencies/console.sol";
import "../Interfaces/ISATOToken.sol";
import "../Interfaces/ISATOStaking.sol";
import "../Dependencies/LiquityMath.sol";
import "../Interfaces/IBTUSDToken.sol";
import "../Dependencies/IERC20.sol";

contract SATOStaking is ISATOStaking, Ownable, CheckContract, BaseMath {
    using SafeMath for uint;

    // --- Data ---
    string constant public NAME = "SATOStaking";
    uint256 constant public PREMIUM_STAKING = 1024e18;

    mapping(address => uint) public stakes;
    uint public totalSATOStaked;

    uint public F_ETH;  // Running sum of collateral redemption fees per-SATO-staked
    uint public F_LUSD; // Running sum of debt mint fees per-SATO-staked

    // User snapshots of F_ETH and F_BTUSD, taken at the point at which their latest deposit was made
    mapping (address => Snapshot) public snapshots; 
	
    // premium status
    mapping (address => bool) public premiumStakers; 

    struct Snapshot {
        uint F_ETH_Snapshot;
        uint F_BTUSD_Snapshot;
    }
    
    ISATOToken public satoToken;
    IBTUSDToken public debtToken;

    address public troveManagerAddress;
    address public borrowerOperationsAddress;
    address public activePoolAddress;
	
    IERC20 public collateral;

    // --- Events ---

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
    event PremiumStaking(address _staker);

    // --- Functions ---

    function setAddresses
    (
        address _satoTokenAddress,
        address _debtTokenAddress,
        address _troveManagerAddress, 
        address _borrowerOperationsAddress,
        address _activePoolAddress,
        address _collAddress
    ) 
        external 
        onlyOwner 
        override 
    {
        checkContract(_satoTokenAddress);
        checkContract(_debtTokenAddress);
        checkContract(_troveManagerAddress);
        checkContract(_borrowerOperationsAddress);
        checkContract(_activePoolAddress);
        checkContract(_collAddress);

        satoToken = ISATOToken(_satoTokenAddress);
        debtToken = IBTUSDToken(_debtTokenAddress);
        troveManagerAddress = _troveManagerAddress;
        borrowerOperationsAddress = _borrowerOperationsAddress;
        activePoolAddress = _activePoolAddress;
        collateral = IERC20(_collAddress);

        emit SATOTokenAddressSet(_satoTokenAddress);
        emit BTUSDTokenAddressSet(_debtTokenAddress);
        emit TroveManagerAddressSet(_troveManagerAddress);
        emit BorrowerOperationsAddressSet(_borrowerOperationsAddress);
        emit ActivePoolAddressSet(_activePoolAddress);

        _renounceOwnership();
    }

    // If caller has a pre-existing stake, send any accumulated collateral and debt gains to them. 
    function stake(uint _amount) external override {
        _requireNonZeroAmount(_amount);
        _stakeInternal(msg.sender, _amount);
    }
	
    function _stakeInternal(address _staker, uint _amount) internal {
        uint currentStake = stakes[_staker];

        uint ETHGain;
        uint debtGain;
        // Grab any accumulated ETH and debt gains from the current stake
        if (currentStake != 0) {
            ETHGain = _getPendingETHGain(_staker);
            debtGain = _getPendingDebtGain(_staker);
        }
    
        _updateUserSnapshots(_staker);

        uint newStake = currentStake.add(_amount);

        // Increase user’s stake and total SATO staked
        stakes[_staker] = newStake;
        totalSATOStaked = totalSATOStaked.add(_amount);
        emit TotalSATOStakedUpdated(totalSATOStaked);

        // Transfer SATO from caller to this contract
        satoToken.sendToStaking(_staker, _amount);

        emit StakeChanged(_staker, newStake);
        emit StakingGainsWithdrawn(_staker, debtGain, ETHGain);

        // Send accumulated debt and collateral gains to the caller
        if (currentStake != 0) {
            debtToken.transfer(_staker, debtGain);
            _sendCollGainToUser(ETHGain);
        }
    }

    // Unstake the SATO and send the it back to the caller, along with their accumulated debt & collateral gains. 
    // If requested amount > stake, send their entire stake.
    function unstake(uint _amount) external override {
        uint currentStake = stakes[msg.sender];
        if (ifPremiumStaking(msg.sender)){
            currentStake = currentStake.sub(PREMIUM_STAKING);
        }
        _requireUserHasStake(currentStake);

        // Grab any accumulated collateral and debt gains from the current stake
        uint ETHGain = _getPendingETHGain(msg.sender);
        uint debtGain = _getPendingDebtGain(msg.sender);
        
        _updateUserSnapshots(msg.sender);

        if (_amount > 0) {
            uint toWithdraw = LiquityMath._min(_amount, currentStake);

            uint newStake = currentStake.sub(toWithdraw);
            if (ifPremiumStaking(msg.sender)){
                newStake = newStake.add(PREMIUM_STAKING);
            }

            // Decrease user's stake and total SATO staked
            stakes[msg.sender] = newStake;
            totalSATOStaked = totalSATOStaked.sub(toWithdraw);
            emit TotalSATOStakedUpdated(totalSATOStaked);

            // Transfer unstaked SATO to user
            satoToken.transfer(msg.sender, toWithdraw);

            emit StakeChanged(msg.sender, newStake);
        }

        emit StakingGainsWithdrawn(msg.sender, debtGain, ETHGain);

        // Send accumulated debt and ETH gains to the caller
        debtToken.transfer(msg.sender, debtGain);
        _sendCollGainToUser(ETHGain);
    }
	
    function ifPremiumStaking(address _staker) public override view returns(bool){
        return premiumStakers[_staker] && stakes[_staker] >= PREMIUM_STAKING;
    }
	
    function getStakes(address _staker) external override view returns(uint){
        return stakes[_staker];
    }
	
    function goPremiumStaking() external override {
        require(!ifPremiumStaking(msg.sender), "SatoStaking: already premium");		

        // Transfer SATO from caller to this contract
        require(satoToken.balanceOf(msg.sender) >= PREMIUM_STAKING, "SATOStaking: not enough balance for premium");
        _stakeInternal(msg.sender, PREMIUM_STAKING);
        premiumStakers[msg.sender] = true;
        emit PremiumStaking(msg.sender);
    }

    // --- Reward-per-unit-staked increase functions. Called by Liquity core contracts ---

    function increaseF_ETH(uint _collRedemptionFee) external override {
        _requireCallerIsTroveManagerOrAP();
        uint collFeePerSATOStaked;
     
        if (totalSATOStaked > 0) {collFeePerSATOStaked = _collRedemptionFee.mul(DECIMAL_PRECISION).div(totalSATOStaked);}

        F_ETH = F_ETH.add(collFeePerSATOStaked); 
        emit F_ETHUpdated(F_ETH);
    }

    function increaseF_LUSD(uint _debtMintFee) external override {
        _requireCallerIsBO();
        uint debtFeePerSATOStaked;
        
        if (totalSATOStaked > 0) {debtFeePerSATOStaked = _debtMintFee.mul(DECIMAL_PRECISION).div(totalSATOStaked);}
        
        F_LUSD = F_LUSD.add(debtFeePerSATOStaked);
        emit F_BTUSDUpdated(F_LUSD);
    }

    // --- Pending reward functions ---

    function getPendingETHGain(address _user) external view override returns (uint) {
        return _getPendingETHGain(_user);
    }

    function _getPendingETHGain(address _user) internal view returns (uint) {
        uint F_ETH_Snapshot = snapshots[_user].F_ETH_Snapshot;
        uint ETHGain = stakes[_user].mul(F_ETH.sub(F_ETH_Snapshot)).div(DECIMAL_PRECISION);
        return ETHGain;
    }

    function getPendingLUSDGain(address _user) external view override returns (uint) {
        return _getPendingDebtGain(_user);
    }

    function _getPendingDebtGain(address _user) internal view returns (uint) {
        uint F_BTUSD_Snapshot = snapshots[_user].F_BTUSD_Snapshot;
        uint debtGain = stakes[_user].mul(F_LUSD.sub(F_BTUSD_Snapshot)).div(DECIMAL_PRECISION);
        return debtGain;
    }

    // --- Internal helper functions ---

    function _updateUserSnapshots(address _user) internal {
        snapshots[_user].F_ETH_Snapshot = F_ETH;
        snapshots[_user].F_BTUSD_Snapshot = F_LUSD;
        emit StakerSnapshotsUpdated(_user, F_ETH, F_LUSD);
    }

    function _sendCollGainToUser(uint collGain) internal {
        emit EtherSent(msg.sender, collGain);
        require(collateral.transfer(msg.sender, collGain), "SATOStaking: Failed to send accumulated collateral Gain");
    }

    // --- 'require' functions ---

    function _requireCallerIsTroveManagerOrAP() internal view {
        require(msg.sender == troveManagerAddress || msg.sender == activePoolAddress, "SATOStaking: caller is not TroveM nor ActivePool");
    }

    function _requireCallerIsBO() internal view {
        require(msg.sender == borrowerOperationsAddress, "SATOStaking: caller is not BorrowerOperations");
    }

    function _requireUserHasStake(uint currentStake) internal pure {  
        require(currentStake > 0, 'SATOStaking: User must have a non-zero stake');  
    }

    function _requireNonZeroAmount(uint _amount) internal pure {
        require(_amount > 0, 'SATOStaking: Amount must be non-zero');
    }
}

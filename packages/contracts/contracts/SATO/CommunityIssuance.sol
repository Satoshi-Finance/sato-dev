// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/ISATOToken.sol";
import "../Interfaces/ICommunityIssuance.sol";
import "../Dependencies/BaseMath.sol";
import "../Dependencies/LiquityMath.sol";
import "../Dependencies/Ownable.sol";
import "../Dependencies/CheckContract.sol";
import "../Dependencies/SafeMath.sol";


contract CommunityIssuance is ICommunityIssuance, Ownable, CheckContract, BaseMath {
    using SafeMath for uint;

    // --- Data ---

    string constant public NAME = "CommunityIssuance";

    uint constant public SECONDS_IN_ONE_MINUTE = 60;

   /* The issuance factor F determines the curvature of the issuance curve.
    *
    * Minutes in one year: 60*24*365 = 525600
    *
    * For 50% of remaining tokens issued each year, with minutes as time units, we have:
    * 
    * F ** 525600 = 0.5
    * 
    * Re-arranging:
    * 
    * 525600 * ln(F) = ln(0.5)
    * F = 0.5 ** (1/525600)
    * F = 0.999998681227695000 
    */
    uint constant public ISSUANCE_FACTOR = 999998681227695000;

    /* 
    * The community SATO supply cap is the starting balance of the Community Issuance contract.
    * It should be minted to this contract by SATOToken, when the token is deployed.
    * 
    * Set to 32M (slightly less than 1/3) of total SATO supply.
    */
    uint constant public SATOSupplyCap = 32e24; // 32 million

    ISATOToken public satoToken;

    address public stabilityPoolAddress;

    uint public totalSATOIssued;
    uint public immutable deploymentTime;

    // --- Events ---

    event SATOTokenAddressSet(address _satoTokenAddress);
    event StabilityPoolAddressSet(address _stabilityPoolAddress);
    event TotalSATOIssuedUpdated(uint _totalSATOIssued);

    // --- Functions ---

    constructor() public {
        deploymentTime = block.timestamp;
    }

    function setAddresses
    (
        address _satoTokenAddress, 
        address _stabilityPoolAddress
    ) 
        external 
        onlyOwner 
        override 
    {
        checkContract(_satoTokenAddress);
        checkContract(_stabilityPoolAddress);

        satoToken = ISATOToken(_satoTokenAddress);
        stabilityPoolAddress = _stabilityPoolAddress;

        // When SATOToken deployed, it should have transferred CommunityIssuance's SATO entitlement
        uint SATOBalance = satoToken.balanceOf(address(this));
        assert(SATOBalance >= SATOSupplyCap);

        emit SATOTokenAddressSet(_satoTokenAddress);
        emit StabilityPoolAddressSet(_stabilityPoolAddress);

        _renounceOwnership();
    }

    function issueSATO() external override returns (uint) {
        _requireCallerIsStabilityPool();

        uint latestTotalSATOIssued = _getLatestIssuedSATO();
        uint issuance = latestTotalSATOIssued.sub(totalSATOIssued);

        totalSATOIssued = latestTotalSATOIssued;
        emit TotalSATOIssuedUpdated(latestTotalSATOIssued);
        
        return issuance;
    }

    /* Gets 1-f^t    where: f < 1

    f: issuance factor that determines the shape of the curve
    t:  time passed since last SATO issuance event  */
    function _getCumulativeIssuanceFraction() internal view returns (uint) {
        // Get the time passed since deployment
        uint timePassedInMinutes = block.timestamp.sub(deploymentTime).div(SECONDS_IN_ONE_MINUTE);

        // f^t
        uint power = LiquityMath._decPow(ISSUANCE_FACTOR, timePassedInMinutes);

        //  (1 - f^t)
        uint cumulativeIssuanceFraction = (uint(DECIMAL_PRECISION).sub(power));
        assert(cumulativeIssuanceFraction <= DECIMAL_PRECISION); // must be in range [0,1]

        return cumulativeIssuanceFraction;
    }

    function sendSATO(address _account, uint _amount) external override {
        _requireCallerIsStabilityPool();

        satoToken.transfer(_account, _amount);
    }
	
    function _getLatestIssuedSATO() internal view returns(uint256){
        return SATOSupplyCap.mul(_getCumulativeIssuanceFraction()).div(DECIMAL_PRECISION);
    }
	
    function getSATOYetToIssue() public override view returns (uint256) {
        uint latestTotalSATOIssued = _getLatestIssuedSATO();
        return latestTotalSATOIssued >= SATOSupplyCap? 0 : SATOSupplyCap.sub(latestTotalSATOIssued);
    }

    // --- 'require' functions ---

    function _requireCallerIsStabilityPool() internal view {
        require(msg.sender == stabilityPoolAddress, "CommunityIssuance: caller is not SP");
    }
}

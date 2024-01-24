// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

// Common interface for the Trove Manager.
interface IBorrowerOperations {

    // --- Events ---

    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _activePoolAddress);
    event DefaultPoolAddressChanged(address _defaultPoolAddress);
    event StabilityPoolAddressChanged(address _stabilityPoolAddress);
    event CollSurplusPoolAddressChanged(address _collSurplusPoolAddress);
    event PriceFeedAddressChanged(address  _newPriceFeedAddress);
    event BTUSDTokenAddressChanged(address _debtTokenAddress);
    event SATOStakingAddressChanged(address _satoStakingAddress);

    event TroveCreated(address indexed _borrower, uint arrayIndex);
    event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint stake, uint8 operation);
    event BTUSDBorrowingFeePaid(address indexed _borrower, uint _debtFee);

    // --- Functions ---

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
    ) external;

    function openTrove(uint _maxFee, uint _debtAmount, uint _collAmount) external;

    function addColl(uint _collAmount) external;

    function moveCollGainToTrove(address _user, uint _collAmount) external;

    function withdrawColl(uint _amount) external;

    function withdrawDebt(uint _maxFee, uint _amount) external;

    function repayDebt(uint _amount) external;

    function closeTrove() external;

    function adjustTrove(uint _maxFee, uint _collChange, bool isCollIncrease, uint _debtChange, bool isDebtIncrease) external;

    function claimCollateral() external;
}

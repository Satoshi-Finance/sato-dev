// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/CheckContract.sol";
import "../Interfaces/IBorrowerOperations.sol";


contract BorrowerOperationsScript is CheckContract {
    IBorrowerOperations immutable borrowerOperations;

    constructor(IBorrowerOperations _borrowerOperations) public {
        checkContract(address(_borrowerOperations));
        borrowerOperations = _borrowerOperations;
    }

    function openTrove(uint _maxFee, uint _debtAmount, uint _collAmt) external payable {
        borrowerOperations.openTrove(_maxFee, _debtAmount, _collAmt);
    }

    function addColl(uint _collAmt) external payable {
        borrowerOperations.addColl(_collAmt);
    }

    function withdrawColl(uint _amount) external {
        borrowerOperations.withdrawColl(_amount);
    }

    function withdrawLUSD(uint _maxFee, uint _amount) external {
        borrowerOperations.withdrawDebt(_maxFee, _amount);
    }

    function repayLUSD(uint _amount) external {
        borrowerOperations.repayDebt(_amount);
    }

    function closeTrove() external {
        borrowerOperations.closeTrove();
    }

    function adjustTrove(uint _maxFee, uint _collChange, bool isCollIncrease, uint _debtChange, bool isDebtIncrease) external payable {
        borrowerOperations.adjustTrove(_maxFee, _collChange, isCollIncrease, _debtChange, isDebtIncrease);
    }

    function claimCollateral() external {
        borrowerOperations.claimCollateral();
    }
}

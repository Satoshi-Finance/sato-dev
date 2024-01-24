// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./IPool.sol";


interface IActivePool is IPool {
    // --- Events ---
    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolBTUSDDebtUpdated(uint _debt);
    event ActivePoolETHBalanceUpdated(uint _ETH);
    event ActivePoolRedeemedDebtUpdated(uint _redeemedDebt);
    event CollateralFlashloan(address indexed _borrower, uint256 _amount, uint256 _fee);

    // --- Functions ---
    function sendETH(address _account, uint _amount) external;
    function receiveCollateral(uint256 _amount) external;
    function increaseRedemptionDebt(uint _amount) external;
    function sendDebtFromRedemption(address _borrower, uint256 _amount) external;
    function decreaseRedemptionDebt(uint _amount) external;
    function getRedeemedDebt() external view returns (uint);
}

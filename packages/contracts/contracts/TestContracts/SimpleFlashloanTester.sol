pragma solidity 0.6.11;

import {IERC3156FlashBorrower} from "../Dependencies/IERC3156FlashBorrower.sol";
import {IERC3156FlashLender} from "../Dependencies/IERC3156FlashLender.sol";
import {IERC20} from "../Dependencies/IERC20.sol";
import "../Dependencies/SafeMath.sol";

interface IBorrowerOperations {
    function openTrove(uint _maxFee, uint _debtAmount, uint _collAmount) external;
}

contract SimpleFlashloanTester is IERC3156FlashBorrower {
    using SafeMath for uint256;
    IBorrowerOperations public borrowerOperations;

    function setBorrowerOperations(address _borrowerOperations) external {
        borrowerOperations = IBorrowerOperations(_borrowerOperations);
    }

    function initFlashLoanToOpenTrove(address lender, address token, uint256 amount, uint256 _debt) external {
        IERC3156FlashLender(lender).flashLoan(
            IERC3156FlashBorrower(address(this)),
            token,
            amount,
            abi.encodePacked(_debt)
        );
    }

    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        uint256 _debt = abi.decode(data, (uint256));
        uint256 _total = amount.add(fee);
		
        IERC20(token).approve(address(borrowerOperations), amount);
        borrowerOperations.openTrove(1e18, _debt, amount);
		
        IERC20(token).approve(msg.sender, _total);
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }
}

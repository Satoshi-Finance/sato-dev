// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/IBTUSDToken.sol";

contract BTUSDTokenCaller {
    IBTUSDToken btUSD;

    function setLUSD(IBTUSDToken _btUSD) external {
        btUSD = _btUSD;
    }

    function lusdMint(address _account, uint _amount) external {
        btUSD.mint(_account, _amount);
    }

    function lusdBurn(address _account, uint _amount) external {
        btUSD.burn(_account, _amount);
    }

    function lusdSendToPool(address _sender,  address _poolAddress, uint256 _amount) external {
        btUSD.sendToPool(_sender, _poolAddress, _amount);
    }

    function lusdReturnFromPool(address _poolAddress, address _receiver, uint256 _amount ) external {
        btUSD.returnFromPool(_poolAddress, _receiver, _amount);
    }
}

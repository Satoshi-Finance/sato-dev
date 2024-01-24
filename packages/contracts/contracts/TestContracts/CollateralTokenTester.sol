// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "../Dependencies/IERC20.sol";
import "../Dependencies/Ownable.sol";

// based on WETH9 contract
contract CollateralTokenTester is IERC20, Ownable {
    string public override name = "Collateral Token Tester in btUSD";
    string public override symbol = "CollTester";
    uint8 public override decimals = 18;

    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);
    event Transfer(address indexed _src, address indexed _dst, uint256 _amt);
    event UncappedMinterAdded(address indexed account);
    event UncappedMinterRemoved(address indexed account);
    event MintCapSet(uint256 indexed newCap);
    event MintCooldownSet(uint256 indexed newCooldown);

    uint256 private _totalBalance;
    mapping(address => uint256) private balances;
    mapping(address => uint256) private depositBalances;
    mapping(address => mapping(address => uint256)) public override allowance;
    mapping(address => bool) public isUncappedMinter;
    mapping(address => uint256) public lastMintTime;

    // Faucet capped at 10 Collateral tokens per day
    uint256 public mintCap = 10e18;
    uint256 public mintCooldown = 60 * 60 * 24;

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        uint256 _wad = msg.value;
        balances[msg.sender] += _wad;
        depositBalances[msg.sender] += _wad;
        _totalBalance += _wad;
        emit Deposit(msg.sender, _wad);
    }

    /// @dev get collateral without native token for testing purposes
    function faucet(uint256 wad) external {
        if (!isUncappedMinter[msg.sender] && msg.sender != owner()) {
            require(wad <= mintCap, "CollTester: Above mint cap");
            require(
                lastMintTime[msg.sender] == 0 || lastMintTime[msg.sender] + mintCooldown < block.timestamp,
                "CollTester: Cooldown period not completed"
            );
            lastMintTime[msg.sender] = block.timestamp;
        }
        balances[msg.sender] += wad;
        _totalBalance += wad;
        emit Deposit(msg.sender, wad);
    }

    function withdraw(uint256 wad) public {
        require(depositBalances[msg.sender] >= wad);
        balances[msg.sender] -= wad;
        depositBalances[msg.sender] -= wad;
        _totalBalance -= wad;
        payable(msg.sender).transfer(wad);
        emit Withdrawal(msg.sender, wad);
    }

    function totalSupply() public view override returns (uint) {
        return _totalBalance;
    }

    // Permissioned functions
    function addUncappedMinter(address account) external onlyOwner {
        isUncappedMinter[account] = true;
        emit UncappedMinterAdded(account);
    }

    function removeUncappedMinter(address account) external onlyOwner {
        isUncappedMinter[account] = false;
        emit UncappedMinterRemoved(account);
    }

    function setMintCap(uint256 newCap) external onlyOwner {
        mintCap = newCap;
        emit MintCapSet(newCap);
    }

    function setMintCooldown(uint256 newCooldown) external onlyOwner {
        mintCooldown = newCooldown;
        emit MintCooldownSet(newCooldown);
    }

    function approve(address guy, uint256 wad) public override returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    // helper to set allowance in test
    function nonStandardSetApproval(
        address owner,
        address guy,
        uint256 wad
    ) external returns (bool) {
        allowance[owner][guy] = wad;
        emit Approval(owner, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) public override returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public override returns (bool) {
        require(balances[src] >= wad, "ERC20: transfer amount exceeds balance");

        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad);
            allowance[src][msg.sender] -= wad;
        }

        balances[src] -= wad;
        balances[dst] += wad;

        _emitTransferEvents(src, dst, wad);

        return true;
    }

    function decreaseAllowance(
        address spender,
        uint256 subtractedValue
    ) external override returns (bool) {
        approve(spender, allowance[msg.sender][spender] - subtractedValue);
        return true;
    }

    function balanceOf(address _usr) external view override returns (uint256) {
        return balances[_usr];
    }

    function increaseAllowance(
        address spender,
        uint256 addedValue
    ) external override returns (bool) {
        approve(spender, allowance[msg.sender][spender] + addedValue);
        return true;
    }

    /**
     * @dev Emits {Transfer} events
     */
    function _emitTransferEvents(
        address _from,
        address _to,
        uint _tokenAmount
    ) internal {
        emit Transfer(_from, _to, _tokenAmount);
    }
}

const StabilityPool = artifacts.require("./StabilityPool.sol")
const ActivePool = artifacts.require("./ActivePoolTester.sol")
const DefaultPool = artifacts.require("./DefaultPoolTester.sol")
const NonPayable = artifacts.require("./NonPayable.sol")
const CollateralToken = artifacts.require("./CollateralTokenTester.sol")

const testHelpers = require("../utils/testHelpers.js")

const th = testHelpers.TestHelper
const dec = th.dec

const _minus_1_Ether = web3.utils.toWei('-1', 'ether')

contract('StabilityPool', async accounts => {
  /* mock* are EOA’s, temporarily used to call protected functions.
  TODO: Replace with mock contracts, and later complete transactions from EOA
  */
  let stabilityPool

  const [owner, alice] = accounts;

  beforeEach(async () => {
    stabilityPool = await StabilityPool.new()
    const mockActivePoolAddress = (await NonPayable.new()).address
    const dumbContractAddress = (await NonPayable.new()).address
    await stabilityPool.setAddresses(dumbContractAddress, dumbContractAddress, mockActivePoolAddress, dumbContractAddress, dumbContractAddress, dumbContractAddress, dumbContractAddress)
  })

  it('getETH(): gets the recorded ETH balance', async () => {
    const recordedETHBalance = await stabilityPool.getETH()
    assert.equal(recordedETHBalance, 0)
  })

  it('getTotalDebtDeposits(): gets the recorded debt balance', async () => {
    const recordedDebtBalance = await stabilityPool.getTotalDebtDeposits()
    assert.equal(recordedDebtBalance, 0)
  })
})

contract('ActivePool', async accounts => {

  let activePool, mockBorrowerOperations, collateralToken

  const [owner, alice] = accounts;
  beforeEach(async () => {
    activePool = await ActivePool.new()
    mockBorrowerOperations = await NonPayable.new()
    collateralToken = await CollateralToken.new()
    const dumbContractAddress = (await NonPayable.new()).address
    await activePool.setAddresses(mockBorrowerOperations.address, dumbContractAddress, dumbContractAddress, dumbContractAddress, dumbContractAddress, collateralToken.address, dumbContractAddress, dumbContractAddress)
  })

  it('getETH(): gets the recorded ETH balance', async () => {
    const recordedETHBalance = await activePool.getETH()
    assert.equal(recordedETHBalance, 0)
  })

  it('getLUSDDebt(): gets the recorded LUSD balance', async () => {
    const recordedETHBalance = await activePool.getLUSDDebt()
    assert.equal(recordedETHBalance, 0)
  })
 
  it('increaseLUSD(): increases the recorded LUSD balance by the correct amount', async () => {
    const recordedLUSD_balanceBefore = await activePool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceBefore, 0)

    // await activePool.increaseLUSDDebt(100, { from: mockBorrowerOperationsAddress })
    const increaseLUSDDebtData = th.getTransactionData('increaseLUSDDebt(uint256)', ['0x64'])
    const tx = await mockBorrowerOperations.forward(activePool.address, increaseLUSDDebtData)
    assert.isTrue(tx.receipt.status)
    const recordedLUSD_balanceAfter = await activePool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceAfter, 100)
  })
  // Decrease
  it('decreaseLUSD(): decreases the recorded LUSD balance by the correct amount', async () => {
    // start the pool on 100 wei
    //await activePool.increaseLUSDDebt(100, { from: mockBorrowerOperationsAddress })
    const increaseLUSDDebtData = th.getTransactionData('increaseLUSDDebt(uint256)', ['0x64'])
    const tx1 = await mockBorrowerOperations.forward(activePool.address, increaseLUSDDebtData)
    assert.isTrue(tx1.receipt.status)

    const recordedLUSD_balanceBefore = await activePool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceBefore, 100)

    //await activePool.decreaseLUSDDebt(100, { from: mockBorrowerOperationsAddress })
    const decreaseLUSDDebtData = th.getTransactionData('decreaseLUSDDebt(uint256)', ['0x64'])
    const tx2 = await mockBorrowerOperations.forward(activePool.address, decreaseLUSDDebtData)
    assert.isTrue(tx2.receipt.status)
    const recordedLUSD_balanceAfter = await activePool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceAfter, 0)
  })

  // send raw ether
  it('sendETH(): decreases the recorded ETH balance by the correct amount', async () => {
    // setup: give pool 2 ether
    const activePool_initialBalance = web3.utils.toBN(await web3.eth.getBalance(activePool.address))
    assert.equal(activePool_initialBalance, 0)
	  
    // start pool with 2 ether	  
    let _amt = dec(2, 'ether');
    await collateralToken.deposit({ from: owner, value: _amt });  
    await collateralToken.transfer(activePool.address, _amt, { from: owner, value: 0 })
    await activePool.unprotectedReceiveColl(_amt);

    const activePool_BalanceBeforeTx = web3.utils.toBN(await collateralToken.balanceOf(activePool.address))
    const alice_Balance_BeforeTx = web3.utils.toBN(await collateralToken.balanceOf(alice))

    assert.equal(activePool_BalanceBeforeTx, dec(2, 'ether'))

    // send ether from pool to alice
    const sendETHData = th.getTransactionData('sendETH(address,uint256)', [alice, web3.utils.toHex(dec(1, 'ether'))])
    const tx2 = await mockBorrowerOperations.forward(activePool.address, sendETHData, { from: owner })
    assert.isTrue(tx2.receipt.status)

    const activePool_BalanceAfterTx = web3.utils.toBN(await collateralToken.balanceOf(activePool.address))
    const alice_Balance_AfterTx = web3.utils.toBN(await collateralToken.balanceOf(alice))

    const alice_BalanceChange = alice_Balance_AfterTx.sub(alice_Balance_BeforeTx)
    const pool_BalanceChange = activePool_BalanceAfterTx.sub(activePool_BalanceBeforeTx)
    assert.equal(alice_BalanceChange, dec(1, 'ether'))
    assert.equal(pool_BalanceChange, _minus_1_Ether)
  })
})

contract('DefaultPool', async accounts => {
 
  let defaultPool, mockTroveManager, mockActivePool, collateralToken

  const [owner, alice] = accounts;
  beforeEach(async () => {
    defaultPool = await DefaultPool.new()
    mockTroveManager = await NonPayable.new()
    mockActivePool = await NonPayable.new()
    collateralToken = await CollateralToken.new()
    await defaultPool.setAddresses(mockTroveManager.address, mockActivePool.address, collateralToken.address)
  })

  it('getETH(): gets the recorded LUSD balance', async () => {
    const recordedETHBalance = await defaultPool.getETH()
    assert.equal(recordedETHBalance, 0)
  })

  it('getLUSDDebt(): gets the recorded LUSD balance', async () => {
    const recordedETHBalance = await defaultPool.getLUSDDebt()
    assert.equal(recordedETHBalance, 0)
  })
 
  it('increaseLUSD(): increases the recorded LUSD balance by the correct amount', async () => {
    const recordedLUSD_balanceBefore = await defaultPool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceBefore, 0)

    // await defaultPool.increaseLUSDDebt(100, { from: mockTroveManagerAddress })
    const increaseLUSDDebtData = th.getTransactionData('increaseLUSDDebt(uint256)', ['0x64'])
    const tx = await mockTroveManager.forward(defaultPool.address, increaseLUSDDebtData)
    assert.isTrue(tx.receipt.status)

    const recordedLUSD_balanceAfter = await defaultPool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceAfter, 100)
  })
  
  it('decreaseLUSD(): decreases the recorded LUSD balance by the correct amount', async () => {
    // start the pool on 100 wei
    //await defaultPool.increaseLUSDDebt(100, { from: mockTroveManagerAddress })
    const increaseLUSDDebtData = th.getTransactionData('increaseLUSDDebt(uint256)', ['0x64'])
    const tx1 = await mockTroveManager.forward(defaultPool.address, increaseLUSDDebtData)
    assert.isTrue(tx1.receipt.status)

    const recordedLUSD_balanceBefore = await defaultPool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceBefore, 100)

    // await defaultPool.decreaseLUSDDebt(100, { from: mockTroveManagerAddress })
    const decreaseLUSDDebtData = th.getTransactionData('decreaseLUSDDebt(uint256)', ['0x64'])
    const tx2 = await mockTroveManager.forward(defaultPool.address, decreaseLUSDDebtData)
    assert.isTrue(tx2.receipt.status)

    const recordedLUSD_balanceAfter = await defaultPool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceAfter, 0)
  })

  // send raw ether
  it('sendETHToActivePool(): decreases the recorded ETH balance by the correct amount', async () => {
    // setup: give pool 2 ether
    const defaultPool_initialBalance = web3.utils.toBN(await web3.eth.getBalance(defaultPool.address))
    assert.equal(defaultPool_initialBalance, 0)

    // start pool with 2 ether	  
    let _amt = dec(2, 'ether');
    await collateralToken.deposit({ from: owner, value: _amt });  
    await collateralToken.transfer(defaultPool.address, _amt, { from: owner, value: 0 })
    await defaultPool.unprotectedReceiveColl(_amt);

    const defaultPool_BalanceBeforeTx = web3.utils.toBN(await collateralToken.balanceOf(defaultPool.address))
    const activePool_Balance_BeforeTx = web3.utils.toBN(await collateralToken.balanceOf(mockActivePool.address))

    assert.equal(defaultPool_BalanceBeforeTx, dec(2, 'ether'))

    // send ether from pool to alice
    const sendETHData = th.getTransactionData('sendETHToActivePool(uint256)', [web3.utils.toHex(dec(1, 'ether'))])
    const tx2 = await mockTroveManager.forward(defaultPool.address, sendETHData, { from: owner })
    assert.isTrue(tx2.receipt.status)

    const defaultPool_BalanceAfterTx = web3.utils.toBN(await collateralToken.balanceOf(defaultPool.address))
    const activePool_Balance_AfterTx = web3.utils.toBN(await collateralToken.balanceOf(mockActivePool.address))

    const activePool_BalanceChange = activePool_Balance_AfterTx.sub(activePool_Balance_BeforeTx)
    const defaultPool_BalanceChange = defaultPool_BalanceAfterTx.sub(defaultPool_BalanceBeforeTx)
    assert.equal(activePool_BalanceChange, dec(1, 'ether'))
    assert.equal(defaultPool_BalanceChange, _minus_1_Ether)
  })
})

contract('Reset chain state', async accounts => {})

const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const TroveManagerTester = artifacts.require("TroveManagerTester")
const SATOTokenTester = artifacts.require("SATOTokenTester")

const th = testHelpers.TestHelper

const dec = th.dec
const toBN = th.toBN
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const ZERO_ADDRESS = th.ZERO_ADDRESS
const assertRevert = th.assertRevert

const GAS_PRICE = 10000000


const {
  buildUserProxies,
  BorrowerOperationsProxy,
  BorrowerWrappersProxy,
  TroveManagerProxy,
  StabilityPoolProxy,
  TokenProxy,
  SATOStakingProxy
} = require('../utils/proxyHelpers.js')

contract('BorrowerWrappers', async accounts => {

  const [
    owner, alice, bob, carol, dennis, whale,
    A, B, C, D, E,
    defaulter_1, defaulter_2,
    // frontEnd_1, frontEnd_2, frontEnd_3
  ] = accounts;

  const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  let priceFeed
  let debtToken
  let troveManagerOriginal
  let troveManager
  let activePool
  let stabilityPool
  let defaultPool
  let collSurplusPool
  let borrowerOperations
  let borrowerWrappers
  let satoTokenOriginal
  let satoToken
  let satoStaking
  let collateral

  let contracts

  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const openTrove = async (params) => th.openTrove(contracts, params)

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.troveManager = await TroveManagerTester.new()
    contracts = await deploymentHelper.deployDebtToken(contracts)
    const SATOContracts = await deploymentHelper.deploySATOTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisig)

    await deploymentHelper.connectSATOContracts(SATOContracts)
    await deploymentHelper.connectCoreContracts(contracts, SATOContracts)
    await deploymentHelper.connectSATOContractsToCore(SATOContracts, contracts)

    troveManagerOriginal = contracts.troveManager
    satoTokenOriginal = SATOContracts.satoToken

    const users = [ alice, bob, carol, dennis, whale, A, B, C, D, E, defaulter_1, defaulter_2 ]
    await deploymentHelper.deployProxyScripts(contracts, SATOContracts, owner, users)

    priceFeed = contracts.priceFeedTestnet
    debtToken = contracts.debtToken
    troveManager = contracts.troveManager
    activePool = contracts.activePool
    stabilityPool = contracts.stabilityPool
    defaultPool = contracts.defaultPool
    collSurplusPool = contracts.collSurplusPool
    borrowerOperations = contracts.borrowerOperations
    borrowerWrappers = contracts.borrowerWrappers
    satoStaking = SATOContracts.satoStaking
    satoToken = SATOContracts.satoToken
    collateral = contracts.collateral	
	
    // approve BorrowerOperations for CDP proxy
    for (let usr of users) {
         const usrProxyAddress = borrowerWrappers.getProxyAddressFromUser(usr)
         await collateral.nonStandardSetApproval(usrProxyAddress, borrowerOperations.address, mv._1Be18BN);
    }
  })

  it('proxy owner can recover ETH', async () => {
    const amount = toBN(dec(1, 18))
    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)

    // send some ETH to proxy
    await web3.eth.sendTransaction({ from: owner, to: proxyAddress, value: amount, gasPrice: GAS_PRICE })
    assert.equal(await web3.eth.getBalance(proxyAddress), amount.toString())

    const balanceBefore = toBN(await web3.eth.getBalance(alice))

    // recover ETH
    const gas_Used = th.gasUsed(await borrowerWrappers.transferETH(alice, amount, { from: alice, gasPrice: GAS_PRICE }))
    
    const balanceAfter = toBN(await web3.eth.getBalance(alice))
    const expectedBalance = toBN(balanceBefore.sub(toBN(gas_Used * GAS_PRICE)))
    assert.equal(balanceAfter.sub(expectedBalance), amount.toString())
  })

  it('non proxy owner cannot recover ETH', async () => {
    const amount = toBN(dec(1, 18))
    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)

    // send some ETH to proxy
    await web3.eth.sendTransaction({ from: owner, to: proxyAddress, value: amount })
    assert.equal(await web3.eth.getBalance(proxyAddress), amount.toString())

    const balanceBefore = toBN(await web3.eth.getBalance(alice))

    // try to recover ETH
    const proxy = borrowerWrappers.getProxyFromUser(alice)
    const signature = 'transferETH(address,uint256)'
    const calldata = th.getTransactionData(signature, [alice, amount])
    await assertRevert(proxy.methods["execute(address,bytes)"](borrowerWrappers.scriptAddress, calldata, { from: bob }), 'ds-auth-unauthorized')

    assert.equal(await web3.eth.getBalance(proxyAddress), amount.toString())

    const balanceAfter = toBN(await web3.eth.getBalance(alice))
    assert.equal(balanceAfter, balanceBefore.toString())
  })

  // --- claimCollateralAndOpenTrove ---

  it('claimCollateralAndOpenTrove(): reverts if nothing to claim', async () => {
    // Whale opens Trove
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: whale, usrProxy: borrowerWrappers.getProxyAddressFromUser(whale) } })

    // alice opens Trove
    const { debtAmount, collateral:coll } = await openTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: alice, usrProxy: borrowerWrappers.getProxyAddressFromUser(alice) } })

    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)
    assert.equal(await web3.eth.getBalance(proxyAddress), '0')

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
	
    let _collAmt = toBN(dec(1,18));
    await collateral.deposit({from: alice, value: _collAmt});

    // alice claims collateral and re-opens the trove
    await assertRevert(
      borrowerWrappers.claimCollateralAndOpenTrove(th._100pct, debtAmount, _collAmt, { from: alice }),
      'CollSurplusPool: No collateral available to claim'
    )

    // check everything remain the same
    assert.equal(await web3.eth.getBalance(proxyAddress), '0')
    th.assertIsApproximatelyEqual(await collSurplusPool.getCollateral(proxyAddress), '0')
    th.assertIsApproximatelyEqual(await debtToken.balanceOf(proxyAddress), debtAmount)
    assert.equal(await troveManager.getTroveStatus(proxyAddress), 1)
    th.assertIsApproximatelyEqual(await troveManager.getTroveColl(proxyAddress), coll)
  })

  it('redemption check', async () => {
    // alice opens Trove
    const { debtAmount, netDebt: redeemAmount, collateral } = await openTrove({ extraParams: { from: alice, usrProxy: borrowerWrappers.getProxyAddressFromUser(alice) } })
    // Whale opens Trove
    await openTrove({ extraLUSDAmount: redeemAmount, ICR: toBN(dec(2, 18)), extraParams: { from: whale, usrProxy: borrowerWrappers.getProxyAddressFromUser(whale) } })

    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)
    assert.equal(await web3.eth.getBalance(proxyAddress), '0')

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
	
    const troveCollBefore = await troveManager.getTroveColl(alice)
    const troveDebtBefore = await troveManager.getTroveDebt(alice)

    // whale redeems 150 LUSD
    await th.redeemCollateral(whale, contracts, redeemAmount, GAS_PRICE)
    assert.equal(await web3.eth.getBalance(proxyAddress), '0')
	
    // get pending share after redemption
    let _entireDebtAndColl = await troveManager.getEntireDebtAndColl(alice);
    let _pendingRedemptionDebt = _entireDebtAndColl[4]
    let _pendingRedemptionColl = _entireDebtAndColl[5]

    // final check
    assert.equal(await troveManager.getTroveStatus(alice), 1) // still active after redemption	
    th.assertIsApproximatelyEqual(_entireDebtAndColl[0], troveDebtBefore.sub(_entireDebtAndColl[4]), 10000)
    th.assertIsApproximatelyEqual(_entireDebtAndColl[1], troveCollBefore.sub(_entireDebtAndColl[5]), 10000)
  })

  // --- claimSPRewardsAndRecycle ---

  it('claimSPRewardsAndRecycle(): only owner can call it', async () => {
    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale, usrProxy: borrowerWrappers.getProxyAddressFromUser(whale) } })
    // Whale deposits 1850 LUSD in StabilityPool
    await stabilityPool.provideToSP(dec(1850, 18), ZERO_ADDRESS, { from: whale })

    // alice opens trove and provides 150 LUSD to StabilityPool
    await openTrove({ extraLUSDAmount: toBN(dec(150, 18)), extraParams: { from: alice, usrProxy: borrowerWrappers.getProxyAddressFromUser(alice) } })
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice })

    // Defaulter Trove opened
    await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1, usrProxy: borrowerWrappers.getProxyAddressFromUser(defaulter_1) } })

    // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
    const price = toBN(dec(100, 18))
    await priceFeed.setPrice(price);

    // Defaulter trove closed
    const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner })
    const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1)

    // Bob tries to claims SP rewards in behalf of Alice
    const proxy = borrowerWrappers.getProxyFromUser(alice)
    const signature = 'claimSPRewardsAndRecycle(uint256,address,address)'
    const calldata = th.getTransactionData(signature, [th._100pct, alice, alice])
    await assertRevert(proxy.methods["execute(address,bytes)"](borrowerWrappers.scriptAddress, calldata, { from: bob }), 'ds-auth-unauthorized')
  })

  it('claimSPRewardsAndRecycle():', async () => {
    // Whale opens Trove
    const whaleDeposit = toBN(dec(2350, 18))
    await openTrove({ extraLUSDAmount: whaleDeposit, ICR: toBN(dec(4, 18)), extraParams: { from: whale, usrProxy: borrowerWrappers.getProxyAddressFromUser(whale) } })
    // Whale deposits 1850 LUSD in StabilityPool
    await stabilityPool.provideToSP(whaleDeposit, ZERO_ADDRESS, { from: whale })

    // alice opens trove and provides 150 LUSD to StabilityPool
    const aliceDeposit = toBN(dec(150, 18))
    await openTrove({ extraLUSDAmount: aliceDeposit, ICR: toBN(dec(3, 18)), extraParams: { from: alice, usrProxy: borrowerWrappers.getProxyAddressFromUser(alice) } })
    await stabilityPool.provideToSP(aliceDeposit, ZERO_ADDRESS, { from: alice })

    // Defaulter Trove opened
    const { lusdAmount, netDebt, collateral:collAmt } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1, usrProxy: borrowerWrappers.getProxyAddressFromUser(defaulter_1) } })

    // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
    const price = toBN(dec(100, 18))
    await priceFeed.setPrice(price);

    // Defaulter trove closed
    const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner })
    const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1)

    // Alice LUSDLoss is ((150/2500) * liquidatedDebt)
    const totalDeposits = whaleDeposit.add(aliceDeposit)
    const expectedLUSDLoss_A = liquidatedDebt_1.mul(aliceDeposit).div(totalDeposits)

    const expectedCompoundedLUSDDeposit_A = toBN(dec(150, 18)).sub(expectedLUSDLoss_A)
    const compoundedLUSDDeposit_A = await stabilityPool.getCompoundedDebtDeposit(alice)
    // collateral * 150 / 2500 * 0.995
    const expectedETHGain_A = toBN(collAmt.toString()).mul(aliceDeposit).div(totalDeposits).mul(toBN(dec(995, 15))).div(mv._1e18BN)

    assert.isAtMost(th.getDifference(expectedCompoundedLUSDDeposit_A, compoundedLUSDDeposit_A), 1000)

    const ethBalanceBefore = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollBefore = await troveManager.getTroveColl(alice)
    const lusdBalanceBefore = await debtToken.balanceOf(alice)
    const troveDebtBefore = await troveManager.getTroveDebt(alice)
    const satoBalanceBefore = await satoToken.balanceOf(alice)
    const ICRBefore = await troveManager.getCurrentICR(alice, price)
    const depositBefore = (await stabilityPool.deposits(alice))[0]
    const stakeBefore = await satoStaking.stakes(alice)

    const proportionalLUSD = expectedETHGain_A.mul(price).div(ICRBefore)
    const borrowingRate = await troveManagerOriginal.getBorrowingRateWithDecayForBorrower(alice)
    const netDebtChange = proportionalLUSD.mul(mv._1e18BN).div(mv._1e18BN.add(borrowingRate))

    // to force SATO issuance
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const expectedSATOGain_A = toBN('50375889811155363785201');//50373424199406504708132

    await priceFeed.setPrice(price.mul(toBN(2)));

    // Alice claims SP rewards and puts them back in the system through the proxy
    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)
    await borrowerWrappers.claimSPRewardsAndRecycle(th._100pct, { from: alice })

    const ethBalanceAfter = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollAfter = await troveManager.getTroveColl(alice)
    const lusdBalanceAfter = await debtToken.balanceOf(alice)
    const troveDebtAfter = await troveManager.getTroveDebt(alice)
    const satoBalanceAfter = await satoToken.balanceOf(alice)
    const ICRAfter = await troveManager.getCurrentICR(alice, price)
    const depositAfter = (await stabilityPool.deposits(alice))[0]
    const stakeAfter = await satoStaking.stakes(alice)

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString())
    assert.equal(lusdBalanceAfter.toString(), lusdBalanceBefore.toString())
    assert.equal(satoBalanceAfter.toString(), satoBalanceBefore.toString())
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore.add(proportionalLUSD))
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore.add(expectedETHGain_A))
    // check that ICR remains constant
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore)
    // check that Stability Pool deposit
    th.assertIsApproximatelyEqual(depositAfter, depositBefore.sub(expectedLUSDLoss_A).add(netDebtChange))
    // check SATO balance remains the same
    th.assertIsApproximatelyEqual(satoBalanceAfter, satoBalanceBefore)

    // SATO staking
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore.add(expectedSATOGain_A))

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorETHGain(alice)
    assert.equal(alice_pendingETHGain, 0)
  })


  // --- claimStakingGainsAndRecycle ---

  it('claimStakingGainsAndRecycle(): only owner can call it', async () => {
    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale, usrProxy: borrowerWrappers.getProxyAddressFromUser(whale) } })

    // alice opens trove
    await openTrove({ extraLUSDAmount: toBN(dec(150, 18)), extraParams: { from: alice, usrProxy: borrowerWrappers.getProxyAddressFromUser(alice) } })

    // mint some SATO
    await satoTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18))
    await satoTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18))

    // stake SATO
    await satoStaking.stake(dec(1850, 18), { from: whale })
    await satoStaking.stake(dec(150, 18), { from: alice })

    // Defaulter Trove opened
    const { lusdAmount, netDebt, totalDebt, collateral } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1, usrProxy: borrowerWrappers.getProxyAddressFromUser(defaulter_1) } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // whale redeems 100 LUSD
    const redeemedAmount = toBN(dec(100, 18))
    await th.redeemCollateral(whale, contracts, redeemedAmount, GAS_PRICE)

    // Bob tries to claims staking gains in behalf of Alice
    const proxy = borrowerWrappers.getProxyFromUser(alice)
    const signature = 'claimStakingGainsAndRecycle(uint256,address,address)'
    const calldata = th.getTransactionData(signature, [th._100pct, alice, alice])
    await assertRevert(proxy.methods["execute(address,bytes)"](borrowerWrappers.scriptAddress, calldata, { from: bob }), 'ds-auth-unauthorized')
  })

  it('claimStakingGainsAndRecycle(): reverts if user has no trove', async () => {
    const price = toBN(dec(200, 18))

    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale, usrProxy: borrowerWrappers.getProxyAddressFromUser(whale) } })
    // Whale deposits 1850 LUSD in StabilityPool
    await stabilityPool.provideToSP(dec(1850, 18), ZERO_ADDRESS, { from: whale })

    // mint some SATO
    await satoTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18))
    await satoTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18))

    // stake SATO
    await satoStaking.stake(dec(1850, 18), { from: whale })
    await satoStaking.stake(dec(150, 18), { from: alice })

    // Defaulter Trove opened
    const { debtAmount, netDebt, totalDebt, collateral } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1, usrProxy: borrowerWrappers.getProxyAddressFromUser(defaulter_1) } })
    const borrowingFee = netDebt.sub(debtAmount)

    // Alice LUSD gain is ((150/2000) * borrowingFee)
    const expectedLUSDGain_A = borrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)))

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // whale redeems 100 LUSD
    const redeemedAmount = toBN(dec(100, 18))
    await th.redeemCollateral(whale, contracts, redeemedAmount, GAS_PRICE)
	
    // get pending share after redemption
    let _entireDebtAndColl = await troveManager.getEntireDebtAndColl(alice);
    console.log('_debt=' + _entireDebtAndColl[0] + ',coll=' + _entireDebtAndColl[1] + ',pendingRDebt=' + _entireDebtAndColl[4] + ',pendingRColl=' + _entireDebtAndColl[5]);
    let _pendingRedemptionDebt = _entireDebtAndColl[4]
    let _pendingRedemptionColl = _entireDebtAndColl[5]

    const ethBalanceBefore = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollBefore = await troveManager.getTroveColl(alice)
    const lusdBalanceBefore = await debtToken.balanceOf(alice)
    const troveDebtBefore = await troveManager.getTroveDebt(alice)
    const satoBalanceBefore = await satoToken.balanceOf(alice)
    const ICRBefore = await troveManager.getCurrentICR(alice, price)
    const depositBefore = (await stabilityPool.deposits(alice))[0]
    const stakeBefore = await satoStaking.stakes(alice)

    // Alice claims staking rewards and puts them back in the system through the proxy
    await assertRevert(
      borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, { from: alice }),
      'BorrowerWrappersScript: caller must have an active trove'
    )

    const ethBalanceAfter = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollAfter = await troveManager.getTroveColl(alice)
    const lusdBalanceAfter = await debtToken.balanceOf(alice)
    const troveDebtAfter = await troveManager.getTroveDebt(alice)
    const satoBalanceAfter = await satoToken.balanceOf(alice)
    const ICRAfter = await troveManager.getCurrentICR(alice, price)
    const depositAfter = (await stabilityPool.deposits(alice))[0]
    const stakeAfter = await satoStaking.stakes(alice)

    // check everything remains the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString())
    assert.equal(lusdBalanceAfter.toString(), lusdBalanceBefore.toString())
    assert.equal(satoBalanceAfter.toString(), satoBalanceBefore.toString())
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore.sub(_pendingRedemptionDebt), 10000)
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore.sub(_pendingRedemptionColl), 10000)
    th.assertIsApproximatelyEqual(depositAfter, depositBefore, 10000)
    th.assertIsApproximatelyEqual(satoBalanceBefore, satoBalanceAfter)
    // SATO staking
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore)

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorETHGain(alice)
    assert.equal(alice_pendingETHGain, 0)
  })

  it('claimStakingGainsAndRecycle(): with only ETH gain', async () => {
    const price = toBN(dec(200, 18))

    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale, usrProxy: borrowerWrappers.getProxyAddressFromUser(whale) } })

    // Defaulter Trove opened
    const { debtAmount, netDebt, collateral } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1, usrProxy: borrowerWrappers.getProxyAddressFromUser(defaulter_1) } })
    const borrowingFee = netDebt.sub(debtAmount)

    // alice opens trove and provides 150 LUSD to StabilityPool
    await openTrove({ extraLUSDAmount: toBN(dec(150, 18)), extraParams: { from: alice, usrProxy: borrowerWrappers.getProxyAddressFromUser(alice) } })
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice })

    // mint some SATO
    await satoTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18))
    await satoTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18))

    // stake SATO
    await satoStaking.stake(dec(1850, 18), { from: whale })
    await satoStaking.stake(dec(150, 18), { from: alice })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // whale redeems 100 LUSD
    const redeemedAmount = toBN(dec(100, 18))
    await th.redeemCollateral(whale, contracts, redeemedAmount, GAS_PRICE)
	
    // get pending share after redemption
    let _entireDebtAndColl = await troveManager.getEntireDebtAndColl(alice);
    console.log('_debt=' + _entireDebtAndColl[0] + ',coll=' + _entireDebtAndColl[1] + ',pendingRDebt=' + _entireDebtAndColl[4] + ',pendingRColl=' + _entireDebtAndColl[5]);
    let _pendingRedemptionDebt = _entireDebtAndColl[4]
    let _pendingRedemptionColl = _entireDebtAndColl[5]

    // Alice ETH gain is ((150/2000) * (redemption fee over redeemedAmount) / price)
    const redemptionFee = await troveManager.getRedemptionFeeWithDecayForRedeemer(whale, redeemedAmount)
    const expectedETHGain_A = redemptionFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18))).mul(mv._1e18BN).div(price)

    const ethBalanceBefore = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollBefore = await troveManager.getTroveColl(alice)
    const lusdBalanceBefore = await debtToken.balanceOf(alice)
    const troveDebtBefore = await troveManager.getTroveDebt(alice)
    const satoBalanceBefore = await satoToken.balanceOf(alice)
    const ICRBefore = await troveManager.getCurrentICR(alice, price)
    const depositBefore = (await stabilityPool.deposits(alice))[0]
    const stakeBefore = await satoStaking.stakes(alice)

    const proportionalLUSD = expectedETHGain_A.mul(price).div(ICRBefore)
    const borrowingRate = await troveManagerOriginal.getBorrowingRateWithDecayForBorrower(alice)
    const netDebtChange = proportionalLUSD.mul(toBN(dec(1, 18))).div(toBN(dec(1, 18)).add(borrowingRate))

    const expectedSATOGain_A = toBN('839598163519256064000000')

    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)
    // Alice claims staking rewards and puts them back in the system through the proxy
    await borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, { from: alice })

    // Alice new LUSD gain due to her own Trove adjustment: ((150/2000) * (borrowing fee over netDebtChange))
    const newBorrowingFee = await troveManagerOriginal.getBorrowingFeeWithDecayForBorrower(alice, netDebtChange)
    const expectedNewLUSDGain_A = newBorrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)))

    const ethBalanceAfter = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollAfter = await troveManager.getTroveColl(alice)
    const lusdBalanceAfter = await debtToken.balanceOf(alice)
    const troveDebtAfter = await troveManager.getTroveDebt(alice)
    const satoBalanceAfter = await satoToken.balanceOf(alice)
    const depositAfter = (await stabilityPool.deposits(alice))[0]
    const stakeAfter = await satoStaking.stakes(alice)

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString())
    assert.equal(satoBalanceAfter.toString(), satoBalanceBefore.toString())
    // check proxy lusd balance has increased by own adjust trove reward
    th.assertIsApproximatelyEqual(lusdBalanceAfter, lusdBalanceBefore.add(expectedNewLUSDGain_A))
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore.add(netDebtChange).add(newBorrowingFee).sub(_pendingRedemptionDebt), 10000)
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore.add(expectedETHGain_A).sub(_pendingRedemptionColl), 10000)
    // check that Stability Pool deposit
    th.assertIsApproximatelyEqual(depositAfter, depositBefore.add(netDebtChange), 10000)
    // check SATO balance remains the same
    th.assertIsApproximatelyEqual(satoBalanceBefore, satoBalanceAfter)

    // SATO staking
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore.add(expectedSATOGain_A))

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorETHGain(alice)
    assert.equal(alice_pendingETHGain, 0)
  })

  it('claimStakingGainsAndRecycle(): with only LUSD gain', async () => {
    const price = toBN(dec(200, 18))

    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale, usrProxy: borrowerWrappers.getProxyAddressFromUser(whale) } })

    // alice opens trove and provides 150 LUSD to StabilityPool
    await openTrove({ extraLUSDAmount: toBN(dec(150, 18)), extraParams: { from: alice, usrProxy: borrowerWrappers.getProxyAddressFromUser(alice) } })
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice })

    // mint some SATO
    await satoTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18))
    await satoTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18))

    // stake SATO
    await satoStaking.stake(dec(1850, 18), { from: whale })
    await satoStaking.stake(dec(150, 18), { from: alice })

    // Defaulter Trove opened
    const { debtAmount, netDebt, collateral } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1, usrProxy: borrowerWrappers.getProxyAddressFromUser(defaulter_1) } })
    const borrowingFee = netDebt.sub(debtAmount)

    // Alice LUSD gain is ((150/2000) * borrowingFee)
    const expectedLUSDGain_A = borrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)))

    const ethBalanceBefore = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollBefore = await troveManager.getTroveColl(alice)
    const lusdBalanceBefore = await debtToken.balanceOf(alice)
    const troveDebtBefore = await troveManager.getTroveDebt(alice)
    const satoBalanceBefore = await satoToken.balanceOf(alice)
    const ICRBefore = await troveManager.getCurrentICR(alice, price)
    const depositBefore = (await stabilityPool.deposits(alice))[0]
    const stakeBefore = await satoStaking.stakes(alice)

    const borrowingRate = await troveManagerOriginal.getBorrowingRateWithDecayForBorrower(alice)

    // Alice claims staking rewards and puts them back in the system through the proxy
    await borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, { from: alice })

    const ethBalanceAfter = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollAfter = await troveManager.getTroveColl(alice)
    const lusdBalanceAfter = await debtToken.balanceOf(alice)
    const troveDebtAfter = await troveManager.getTroveDebt(alice)
    const satoBalanceAfter = await satoToken.balanceOf(alice)
    const ICRAfter = await troveManager.getCurrentICR(alice, price)
    const depositAfter = (await stabilityPool.deposits(alice))[0]
    const stakeAfter = await satoStaking.stakes(alice)

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString())
    assert.equal(satoBalanceAfter.toString(), satoBalanceBefore.toString())
    // check proxy lusd balance has increased by own adjust trove reward
    th.assertIsApproximatelyEqual(lusdBalanceAfter, lusdBalanceBefore)
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore, 10000)
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore)
    // check that ICR remains constant
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore)
    // check that Stability Pool deposit
    th.assertIsApproximatelyEqual(depositAfter, depositBefore.add(expectedLUSDGain_A), 10000)
    // check SATO balance remains the same
    th.assertIsApproximatelyEqual(satoBalanceBefore, satoBalanceAfter)

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorETHGain(alice)
    assert.equal(alice_pendingETHGain, 0)
  })

  it('claimStakingGainsAndRecycle(): with both ETH and LUSD gains', async () => {
    const price = toBN(dec(200, 18))

    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale, usrProxy: borrowerWrappers.getProxyAddressFromUser(whale) } })

    // alice opens trove and provides 150 LUSD to StabilityPool
    await openTrove({ extraLUSDAmount: toBN(dec(150, 18)), extraParams: { from: alice, usrProxy: borrowerWrappers.getProxyAddressFromUser(alice) } })
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice })

    // mint some SATO
    await satoTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18))
    await satoTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18))

    // stake SATO
    await satoStaking.stake(dec(1850, 18), { from: whale })
    await satoStaking.stake(dec(150, 18), { from: alice })

    // Defaulter Trove opened
    const { debtAmount, netDebt, collateral } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1, usrProxy: borrowerWrappers.getProxyAddressFromUser(defaulter_1) } })
    const borrowingFee = netDebt.sub(debtAmount)

    // Alice LUSD gain is ((150/2000) * borrowingFee)
    const expectedLUSDGain_A = borrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)))

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // whale redeems 100 LUSD
    const redeemedAmount = toBN(dec(100, 18))
    await th.redeemCollateral(whale, contracts, redeemedAmount, GAS_PRICE)
	
    // get pending share after redemption
    let _entireDebtAndColl = await troveManager.getEntireDebtAndColl(alice);
    console.log('_debt=' + _entireDebtAndColl[0] + ',coll=' + _entireDebtAndColl[1] + ',pendingRDebt=' + _entireDebtAndColl[4] + ',pendingRColl=' + _entireDebtAndColl[5]);
    let _pendingRedemptionDebt = _entireDebtAndColl[4]
    let _pendingRedemptionColl = _entireDebtAndColl[5]

    // Alice ETH gain is ((150/2000) * (redemption fee over redeemedAmount) / price)
    const redemptionFee = await troveManager.getRedemptionFeeWithDecayForRedeemer(whale, redeemedAmount)
    const expectedETHGain_A = redemptionFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18))).mul(mv._1e18BN).div(price)

    const ethBalanceBefore = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollBefore = await troveManager.getTroveColl(alice)
    const lusdBalanceBefore = await debtToken.balanceOf(alice)
    const troveDebtBefore = await troveManager.getTroveDebt(alice)
    const satoBalanceBefore = await satoToken.balanceOf(alice)
    const ICRBefore = await troveManager.getCurrentICR(alice, price)
    const depositBefore = (await stabilityPool.deposits(alice))[0]
    const stakeBefore = await satoStaking.stakes(alice)

    const proportionalLUSD = expectedETHGain_A.mul(price).div(ICRBefore)
    const borrowingRate = await troveManagerOriginal.getBorrowingRateWithDecayForBorrower(alice)
    const netDebtChange = proportionalLUSD.mul(toBN(dec(1, 18))).div(toBN(dec(1, 18)).add(borrowingRate))
    const expectedTotalLUSD = expectedLUSDGain_A.add(netDebtChange)    
    const expectedSATOGain_A = toBN('839598163519256064000000');//839557069990108416000000

    // Alice claims staking rewards and puts them back in the system through the proxy
    await borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, { from: alice })

    // Alice new LUSD gain due to her own Trove adjustment: ((150/2000) * (borrowing fee over netDebtChange))
    const newBorrowingFee = await troveManagerOriginal.getBorrowingFeeWithDecayForBorrower(alice, netDebtChange)
    const expectedNewLUSDGain_A = newBorrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)))
	
    const ethBalanceAfter = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollAfter = await troveManager.getTroveColl(alice)
    const lusdBalanceAfter = await debtToken.balanceOf(alice)
    const troveDebtAfter = await troveManager.getTroveDebt(alice)
    const satoBalanceAfter = await satoToken.balanceOf(alice)
    const depositAfter = (await stabilityPool.deposits(alice))[0]
    const stakeAfter = await satoStaking.stakes(alice)

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString())
    assert.equal(satoBalanceAfter.toString(), satoBalanceBefore.toString())
    // check proxy lusd balance has increased by own adjust trove reward
    th.assertIsApproximatelyEqual(lusdBalanceAfter, lusdBalanceBefore.add(expectedNewLUSDGain_A))
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore.add(netDebtChange).add(newBorrowingFee).sub(_pendingRedemptionDebt), 10000)
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore.add(expectedETHGain_A).sub(_pendingRedemptionColl), 10000)
    // check that Stability Pool deposit
    th.assertIsApproximatelyEqual(depositAfter, depositBefore.add(expectedTotalLUSD), 10000)
    // check SATO balance remains the same
    th.assertIsApproximatelyEqual(satoBalanceBefore, satoBalanceAfter)

    // SATO staking
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore.add(expectedSATOGain_A))

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorETHGain(alice)
    assert.equal(alice_pendingETHGain, 0)
  })

})

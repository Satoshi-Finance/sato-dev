const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const TroveManagerTester = artifacts.require("./TroveManagerTester.sol")
const BTUSDTokenTester = artifacts.require("./BTUSDTokenTester.sol")
const SimpleFlashloanTester = artifacts.require("./SimpleFlashloanTester.sol")

const th = testHelpers.TestHelper
const dec = th.dec
const toBN = th.toBN
const assertRevert = th.assertRevert
const mv = testHelpers.MoneyValues
const MoneyValues = mv
const timeValues = testHelpers.TimeValues

const GAS_PRICE = 10000000


/* NOTE: Some tests involving ETH redemption fees do not test for specific fee values.
 * Some only test that the fees are non-zero when they should occur.
 *
 * Specific ETH gain values will depend on the final fee schedule used, and the final choices for
 * the parameter BETA in the TroveManager, which is still TBD based on economic modelling.
 * 
 */ 
contract('TroveManager', async accounts => {

  const _18_zeros = '000000000000000000'
  const ZERO_ADDRESS = th.ZERO_ADDRESS

  const [
    owner,
    alice, bob, carol, dennis, erin, flyn, graham, harriet, ida,
    defaulter_1, defaulter_2, defaulter_3, defaulter_4, whale,
    A, B, C, D, E] = accounts;

    const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  let priceFeed
  let debtToken
  let troveManager
  let activePool
  let stabilityPool
  let collSurplusPool
  let defaultPool
  let borrowerOperations
  let collateralToken
  let MIN_DEBT
  let flashloanTester

  let contracts

  const getOpenTroveTotalDebt = async (lusdAmount) => th.getOpenTroveTotalDebt(contracts, lusdAmount)
  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getActualDebtFromComposite = async (compositeDebt) => th.getActualDebtFromComposite(compositeDebt, contracts)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const openTrove = async (params) => th.openTrove(contracts, params)
  const withdrawLUSD = async (params) => th.withdrawLUSD(contracts, params)

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.debtToken = await BTUSDTokenTester.new(
      contracts.troveManager.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address
    )
    const SATOContracts = await deploymentHelper.deploySATOContracts(bountyAddress, lpRewardsAddress, multisig)

    priceFeed = contracts.priceFeedTestnet
    debtToken = contracts.debtToken
    troveManager = contracts.troveManager
    activePool = contracts.activePool
    stabilityPool = contracts.stabilityPool
    defaultPool = contracts.defaultPool
    collSurplusPool = contracts.collSurplusPool
    borrowerOperations = contracts.borrowerOperations
    collateralToken = contracts.collateral
    MIN_DEBT = await troveManager.MIN_NET_DEBT();
    flashloanTester = await SimpleFlashloanTester.new()
    await flashloanTester.setBorrowerOperations(borrowerOperations.address)

    satoStaking = SATOContracts.satoStaking
    satoToken = SATOContracts.satoToken
    communityIssuance = SATOContracts.communityIssuance
    lockupContractFactory = SATOContracts.lockupContractFactory

    await deploymentHelper.connectCoreContracts(contracts, SATOContracts)
    await deploymentHelper.connectSATOContracts(SATOContracts)
    await deploymentHelper.connectSATOContractsToCore(SATOContracts, contracts)
  })

  it('flashloan collateral: happy path for flashloan', async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })	

    let _flAmt = toBN(dec(10, 18)) 
    let _debtAmt = MIN_DEBT 
    let _flFee = await activePool.flashFee(collateralToken.address, _flAmt)
    let _flTotal = _flAmt.add(_flFee)
    await collateralToken.deposit({from : alice, value: _flTotal });
    // sugardaddy flashloan tester
    await collateralToken.transfer(flashloanTester.address, _flTotal, {from : alice});
    let _balOnFLTester = await collateralToken.balanceOf(flashloanTester.address)
    assert.isTrue(_balOnFLTester.eq(_flTotal));

    // initialize flashloan to open a trove	
    let _balInStakingPoolBefore = await collateralToken.balanceOf(satoStaking.address)
    await flashloanTester.initFlashLoanToOpenTrove(activePool.address, collateralToken.address, _flAmt, _debtAmt);
    let _balInStakingPoolAfter = await collateralToken.balanceOf(satoStaking.address)
    assert.isTrue(_balInStakingPoolAfter.eq(_flFee.add(_balInStakingPoolBefore)));
	
    // check flashloan result
    let _flTesterTroveColl = await troveManager.getTroveColl(flashloanTester.address)
    assert.isTrue(_flTesterTroveColl.eq(_flAmt));
    _balOnFLTester = await collateralToken.balanceOf(flashloanTester.address)
    assert.isTrue(_balOnFLTester.eq(toBN('0')));
  })

  it('flashloan collateral: path for flashloan receiver can not repay', async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })	

    let _flAmt = toBN(dec(10, 18)) 
    let _debtAmt = MIN_DEBT 
    let _flTotal = _flAmt.add(await activePool.flashFee(collateralToken.address, _flAmt))

    // initialize flashloan to open a trove but failed
    await assertRevert(flashloanTester.initFlashLoanToOpenTrove(activePool.address, collateralToken.address, _flAmt, _debtAmt), "ActivePool: failed to transfer from flashloan receiver");
  })

  it('flashloan collateral: path for wrong flashloan parameters', async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })	
    let _maxAllowed = await activePool.maxFlashLoan(collateralToken.address)
    let _tooMuch = _maxAllowed.add(toBN('1'))

    // initialize flashloan but failed
    await assertRevert(flashloanTester.initFlashLoanToOpenTrove(activePool.address, collateralToken.address, 0, 0), "ActivePool: Zero amount for flashloan");
    await assertRevert(flashloanTester.initFlashLoanToOpenTrove(activePool.address, collateralToken.address, _tooMuch, 0), "ActivePool: Too much asked for flashloan");
  })

  it('liquidate(): closes a Trove that has ICR < MCR', async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
    await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })

    const price = await priceFeed.getPrice()
    const ICR_Before = await troveManager.getCurrentICR(alice, price)
    assert.equal(ICR_Before, dec(4, 18))

    const MCR = (await troveManager.MCR()).toString()
    assert.equal(MCR.toString(), '1100000000000000000')

    // Alice increases debt to 180 LUSD, lowering her ICR to 1.11
    const A_LUSDWithdrawal = await getNetBorrowingAmount(dec(130, 18))

    const targetICR = toBN('1111111111111111111')
    await withdrawLUSD({ ICR: targetICR, extraParams: { from: alice } })

    const ICR_AfterWithdrawal = await troveManager.getCurrentICR(alice, price)
    assert.isAtMost(th.getDifference(ICR_AfterWithdrawal, targetICR), 100)

    // price drops to 1ETH:100LUSD, reducing Alice's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // close Trove
    await troveManager.liquidate(alice, { from: owner });

    // check the Trove is successfully closed, and removed from sortedList
    const status = (await troveManager.Troves(alice))[3]
    assert.equal(status, 3)  // status enum 3 corresponds to "Closed by liquidation"
  })

  it("liquidate(): decreases ActivePool ETH and LUSDDebt by correct amounts", async () => {
    // --- SETUP ---
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    // --- TEST ---

    // check ActivePool ETH and LUSD debt before
    const activePool_ETH_Before = (await activePool.getETH()).toString()
    const activePool_RawEther_Before = (await collateralToken.balanceOf(activePool.address)).toString()
    const activePool_LUSDDebt_Before = (await activePool.getLUSDDebt()).toString()

    assert.equal(activePool_ETH_Before, A_collateral.add(B_collateral))
    assert.equal(activePool_RawEther_Before, A_collateral.add(B_collateral))
    th.assertIsApproximatelyEqual(activePool_LUSDDebt_Before, A_totalDebt.add(B_totalDebt))

    // price drops to 1ETH:100LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    /* close Bob's Trove. Should liquidate his ether and LUSD, 
    leaving Alice’s ether and LUSD debt in the ActivePool. */
    await troveManager.liquidate(bob, { from: owner });

    // check ActivePool ETH and LUSD debt 
    const activePool_ETH_After = (await activePool.getETH()).toString()
    const activePool_RawEther_After = (await collateralToken.balanceOf(activePool.address)).toString()
    const activePool_LUSDDebt_After = (await activePool.getLUSDDebt()).toString()

    assert.equal(activePool_ETH_After, A_collateral)
    assert.equal(activePool_RawEther_After, A_collateral)
    th.assertIsApproximatelyEqual(activePool_LUSDDebt_After, A_totalDebt)
  })

  it("liquidate(): increases DefaultPool ETH and LUSD debt by correct amounts", async () => {
    // --- SETUP ---
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    // --- TEST ---

    // check DefaultPool ETH and LUSD debt before
    const defaultPool_ETH_Before = (await defaultPool.getETH())
    const defaultPool_RawEther_Before = (await collateralToken.balanceOf(defaultPool.address)).toString()
    const defaultPool_LUSDDebt_Before = (await defaultPool.getLUSDDebt()).toString()

    assert.equal(defaultPool_ETH_Before, '0')
    assert.equal(defaultPool_RawEther_Before, '0')
    assert.equal(defaultPool_LUSDDebt_Before, '0')

    // price drops to 1ETH:100LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // close Bob's Trove
    await troveManager.liquidate(bob, { from: owner });

    // check after
    const defaultPool_ETH_After = (await defaultPool.getETH()).toString()
    const defaultPool_RawEther_After = (await collateralToken.balanceOf(defaultPool.address)).toString()
    const defaultPool_LUSDDebt_After = (await defaultPool.getLUSDDebt()).toString()

    const defaultPool_ETH = th.applyLiquidationFee(B_collateral)
    assert.equal(defaultPool_ETH_After, defaultPool_ETH)
    assert.equal(defaultPool_RawEther_After, defaultPool_ETH)
    th.assertIsApproximatelyEqual(defaultPool_LUSDDebt_After, B_totalDebt)
  })

  it("liquidate(): removes the Trove's stake from the total stakes", async () => {
    // --- SETUP ---
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    // --- TEST ---

    // check totalStakes before
    const totalStakes_Before = (await troveManager.totalStakes()).toString()
    assert.equal(totalStakes_Before, A_collateral.add(B_collateral))

    // price drops to 1ETH:100LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Close Bob's Trove
    await troveManager.liquidate(bob, { from: owner });

    // check totalStakes after
    const totalStakes_After = (await troveManager.totalStakes()).toString()
    assert.equal(totalStakes_After, A_collateral)
  })

  it("liquidate(): Removes the correct trove from the TroveOwners array, and moves the last array element to the new empty slot", async () => {
    // --- SETUP --- 
    await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol, Dennis, Erin open troves with consecutively decreasing collateral ratio
    await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(216, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(214, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(212, 16)), extraParams: { from: dennis } })
    await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: erin } })

    // At this stage, TroveOwners array should be: [W, A, B, C, D, E] 

    // Drop price
    await priceFeed.setPrice(dec(100, 18))

    const arrayLength_Before = await troveManager.getTroveOwnersCount()
    assert.equal(arrayLength_Before, 6)

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Liquidate carol
    await troveManager.liquidate(carol)

    // Check Carol no longer has an active trove
    assert.isFalse((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    // Check length of array has decreased by 1
    const arrayLength_After = await troveManager.getTroveOwnersCount()
    assert.equal(arrayLength_After, 5)

    /* After Carol is removed from array, the last element (Erin's address) should have been moved to fill 
    the empty slot left by Carol, and the array length decreased by one.  The final TroveOwners array should be:
  
    [W, A, B, E, D] 

    Check all remaining troves in the array are in the correct order */
    const trove_0 = await troveManager.TroveOwners(0)
    const trove_1 = await troveManager.TroveOwners(1)
    const trove_2 = await troveManager.TroveOwners(2)
    const trove_3 = await troveManager.TroveOwners(3)
    const trove_4 = await troveManager.TroveOwners(4)

    assert.equal(trove_0, whale)
    assert.equal(trove_1, alice)
    assert.equal(trove_2, bob)
    assert.equal(trove_3, erin)
    assert.equal(trove_4, dennis)

    // Check correct indices recorded on the active trove structs
    const whale_arrayIndex = (await troveManager.Troves(whale))[4]
    const alice_arrayIndex = (await troveManager.Troves(alice))[4]
    const bob_arrayIndex = (await troveManager.Troves(bob))[4]
    const dennis_arrayIndex = (await troveManager.Troves(dennis))[4]
    const erin_arrayIndex = (await troveManager.Troves(erin))[4]

    // [W, A, B, E, D] 
    assert.equal(whale_arrayIndex, 0)
    assert.equal(alice_arrayIndex, 1)
    assert.equal(bob_arrayIndex, 2)
    assert.equal(erin_arrayIndex, 3)
    assert.equal(dennis_arrayIndex, 4)
  })

  it("liquidate(): updates the snapshots of total stakes and total collateral", async () => {
    // --- SETUP ---
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    // --- TEST ---

    // check snapshots before 
    const totalStakesSnapshot_Before = (await troveManager.totalStakesSnapshot()).toString()
    const totalCollateralSnapshot_Before = (await troveManager.totalCollateralSnapshot()).toString()
    assert.equal(totalStakesSnapshot_Before, '0')
    assert.equal(totalCollateralSnapshot_Before, '0')

    // price drops to 1ETH:100LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // close Bob's Trove.  His ether*0.995 and LUSD should be added to the DefaultPool.
    await troveManager.liquidate(bob, { from: owner });

    /* check snapshots after. Total stakes should be equal to the  remaining stake then the system: 
    10 ether, Alice's stake.
     
    Total collateral should be equal to Alice's collateral plus her pending ETH reward (Bob’s collaterale*0.995 ether), earned
    from the liquidation of Bob's Trove */
    const totalStakesSnapshot_After = (await troveManager.totalStakesSnapshot()).toString()
    const totalCollateralSnapshot_After = (await troveManager.totalCollateralSnapshot()).toString()

    assert.equal(totalStakesSnapshot_After, A_collateral)
    assert.equal(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral)))
  })

  it("liquidate(): updates the L_ETH and L_LUSDDebt reward-per-unit-staked totals", async () => {
    // --- SETUP ---
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })
    const { collateral: C_collateral, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(111, 16)), extraParams: { from: carol } })

    // --- TEST ---

    // price drops to 1ETH:100LUSD, reducing Carols's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // close Carol's Trove.  
    assert.isTrue((await troveManager.getTroveStatus(carol)).eq(toBN('1')))
    await troveManager.liquidate(carol, { from: owner });
    assert.isFalse((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    // Carol's ether*0.995 and LUSD should be added to the DefaultPool.
    const L_ETH_AfterCarolLiquidated = await troveManager.L_ETH()
    const L_LUSDDebt_AfterCarolLiquidated = await troveManager.L_LUSDDebt()

    const L_ETH_expected_1 = th.applyLiquidationFee(C_collateral).mul(mv._1e18BN).div(A_collateral.add(B_collateral))
    const L_LUSDDebt_expected_1 = C_totalDebt.mul(mv._1e18BN).div(A_collateral.add(B_collateral))
    assert.isAtMost(th.getDifference(L_ETH_AfterCarolLiquidated, L_ETH_expected_1), 100)
    assert.isAtMost(th.getDifference(L_LUSDDebt_AfterCarolLiquidated, L_LUSDDebt_expected_1), 100)

    // Bob now withdraws LUSD, bringing his ICR to 1.11
    const { increasedTotalDebt: B_increasedTotalDebt } = await withdrawLUSD({ ICR: toBN(dec(111, 16)), extraParams: { from: bob } })

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // price drops to 1ETH:50LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice(dec(50, 18));
    const price = await priceFeed.getPrice()

    // close Bob's Trove 
    assert.isTrue((await troveManager.getTroveStatus(bob)).eq(toBN('1')))
    await troveManager.liquidate(bob, { from: owner });
    assert.isFalse((await troveManager.getTroveStatus(bob)).eq(toBN('1')))

    /* Alice now has all the active stake. totalStakes in the system is now 10 ether.
   
   Bob's pending collateral reward and debt reward are applied to his Trove
   before his liquidation.
   His total collateral*0.995 and debt are then added to the DefaultPool. 
   
   The system rewards-per-unit-staked should now be:
   
   L_ETH = (0.995 / 20) + (10.4975*0.995  / 10) = 1.09425125 ETH
   L_LUSDDebt = (180 / 20) + (890 / 10) = 98 LUSD */
    const L_ETH_AfterBobLiquidated = await troveManager.L_ETH()
    const L_LUSDDebt_AfterBobLiquidated = await troveManager.L_LUSDDebt()

    const L_ETH_expected_2 = L_ETH_expected_1.add(th.applyLiquidationFee(B_collateral.add(B_collateral.mul(L_ETH_expected_1).div(mv._1e18BN))).mul(mv._1e18BN).div(A_collateral))
    const L_LUSDDebt_expected_2 = L_LUSDDebt_expected_1.add(B_totalDebt.add(B_increasedTotalDebt).add(B_collateral.mul(L_LUSDDebt_expected_1).div(mv._1e18BN)).mul(mv._1e18BN).div(A_collateral))
    assert.isAtMost(th.getDifference(L_ETH_AfterBobLiquidated, L_ETH_expected_2), 100)
    assert.isAtMost(th.getDifference(L_LUSDDebt_AfterBobLiquidated, L_LUSDDebt_expected_2), 100)
  })

  it("liquidate(): Liquidates undercollateralized trove if there are two troves in the system", async () => {
    await openTrove({ ICR: toBN(dec(200, 18)), extraParams: { from: bob, value: dec(100, 'ether') } })

    // Alice creates a single trove with 0.7 ETH and a debt of 70 LUSD, and provides 10 LUSD to SP
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

    // Alice proves 10 LUSD to SP
    await stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, { from: alice })

    // Set ETH:USD price to 105
    await priceFeed.setPrice('105000000000000000000')
    const price = await priceFeed.getPrice()

    assert.isFalse(await th.checkRecoveryMode(contracts))

    const alice_ICR = (await troveManager.getCurrentICR(alice, price)).toString()
    assert.equal(alice_ICR, '1050000000000000000')

    const activeTrovesCount_Before = await troveManager.getTroveOwnersCount()

    assert.equal(activeTrovesCount_Before, 2)

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Liquidate the trove
    await troveManager.liquidate(alice, { from: owner })

    // Check Alice's trove is removed, and bob remains
    const activeTrovesCount_After = await troveManager.getTroveOwnersCount()
    assert.equal(activeTrovesCount_After, 1)

    assert.isFalse((await troveManager.getTroveStatus(alice)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(bob)).eq(toBN('1')))
  })

  it("liquidate(): reverts if trove is non-existent", async () => {
    await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    assert.equal(await troveManager.getTroveStatus(carol), 0) // check trove non-existent

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    try {
      const txCarol = await troveManager.liquidate(carol)

      assert.isFalse(txCarol.receipt.status)
    } catch (err) {
      assert.include(err.message, "revert")
      assert.include(err.message, "Trove does not exist or is closed")
    }
  })

  it("liquidate(): reverts if trove has been closed", async () => {
    await openTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

    assert.isTrue((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    // price drops, Carol ICR falls below MCR
    await priceFeed.setPrice(dec(100, 18))

    // Carol liquidated, and her trove is closed
    const txCarol_L1 = await troveManager.liquidate(carol)
    assert.isTrue(txCarol_L1.receipt.status)

    assert.equal(await troveManager.getTroveStatus(carol), 3)  // check trove closed by liquidation

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    try {
      const txCarol_L2 = await troveManager.liquidate(carol)

      assert.isFalse(txCarol_L2.receipt.status)
    } catch (err) {
      assert.include(err.message, "revert")
      assert.include(err.message, "Trove does not exist or is closed")
    }
  })

  it("liquidate(): does nothing if trove has >= 110% ICR", async () => {
    await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: whale } })
    await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: bob } })

    const TCR_Before = (await th.getTCR(contracts)).toString()

    const price = await priceFeed.getPrice()

    // Check Bob's ICR > 110%
    const bob_ICR = await troveManager.getCurrentICR(bob, price)
    assert.isTrue(bob_ICR.gte(mv._MCR))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Attempt to liquidate bob
    await assertRevert(troveManager.liquidate(bob), "TroveManager: nothing to liquidate")

    // Check bob active, check whale active
    assert.isTrue((await troveManager.getTroveStatus(bob)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(whale)).eq(toBN('1')))

    const TCR_After = (await th.getTCR(contracts)).toString()

    assert.equal(TCR_Before, TCR_After)
  })

  it("liquidate(): Given the same price and no other trove changes, complete Pool offsets restore the TCR to its value prior to the defaulters opening troves", async () => {
    // Whale provides LUSD to SP
    const spDeposit = toBN(dec(100, 24))
    await openTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(70, 18)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(200, 18)), extraParams: { from: dennis } })

    const TCR_Before = (await th.getTCR(contracts)).toString()

    await openTrove({ ICR: toBN(dec(202, 16)), extraParams: { from: defaulter_1 } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_2 } })
    await openTrove({ ICR: toBN(dec(196, 16)), extraParams: { from: defaulter_3 } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_4 } })

    assert.isTrue((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_3)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_4)).eq(toBN('1')))

    // Price drop
    await priceFeed.setPrice(dec(100, 18))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // All defaulters liquidated
    await troveManager.liquidate(defaulter_1)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))

    await troveManager.liquidate(defaulter_2)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))

    await troveManager.liquidate(defaulter_3)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_3)).eq(toBN('1')))

    await troveManager.liquidate(defaulter_4)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_4)).eq(toBN('1')))

    // Price bounces back
    await priceFeed.setPrice(dec(200, 18))

    const TCR_After = (await th.getTCR(contracts)).toString()
    assert.equal(TCR_Before, TCR_After)
  })


  it("liquidate(): Pool offsets increase the TCR", async () => {
    // Whale provides LUSD to SP
    const spDeposit = toBN(dec(100, 24))
    await openTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(70, 18)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(200, 18)), extraParams: { from: dennis } })

    await openTrove({ ICR: toBN(dec(202, 16)), extraParams: { from: defaulter_1 } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_2 } })
    await openTrove({ ICR: toBN(dec(196, 16)), extraParams: { from: defaulter_3 } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_4 } })

    assert.isTrue((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_3)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_4)).eq(toBN('1')))

    await priceFeed.setPrice(dec(100, 18))

    const TCR_1 = await th.getTCR(contracts)

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Check TCR improves with each liquidation that is offset with Pool
    await troveManager.liquidate(defaulter_1)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    const TCR_2 = await th.getTCR(contracts)
    assert.isTrue(TCR_2.gte(TCR_1))

    await troveManager.liquidate(defaulter_2)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))
    const TCR_3 = await th.getTCR(contracts)
    assert.isTrue(TCR_3.gte(TCR_2))

    await troveManager.liquidate(defaulter_3)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_3)).eq(toBN('1')))
    const TCR_4 = await th.getTCR(contracts)
    assert.isTrue(TCR_4.gte(TCR_3))

    await troveManager.liquidate(defaulter_4)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_4)).eq(toBN('1')))
    const TCR_5 = await th.getTCR(contracts)
    assert.isTrue(TCR_5.gte(TCR_4))
  })

  it("liquidate(): a pure redistribution reduces the TCR only as a result of compensation", async () => {
    await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(70, 18)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(200, 18)), extraParams: { from: dennis } })

    await openTrove({ ICR: toBN(dec(202, 16)), extraParams: { from: defaulter_1 } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_2 } })
    await openTrove({ ICR: toBN(dec(196, 16)), extraParams: { from: defaulter_3 } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_4 } })

    assert.isTrue((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_3)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_4)).eq(toBN('1')))

    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    const TCR_0 = await th.getTCR(contracts)

    const entireSystemCollBefore = await troveManager.getEntireSystemColl()
    const entireSystemDebtBefore = await troveManager.getEntireSystemDebt()

    const expectedTCR_0 = entireSystemCollBefore.mul(price).div(entireSystemDebtBefore)

    assert.isTrue(expectedTCR_0.eq(TCR_0))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Check TCR does not decrease with each liquidation 
    const liquidationTx_1 = await troveManager.liquidate(defaulter_1)
    const [liquidatedDebt_1, liquidatedColl_1, gasComp_1] = th.getEmittedLiquidationValues(liquidationTx_1)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    const TCR_1 = await th.getTCR(contracts)

    // Expect only change to TCR to be due to the issued gas compensation
    const expectedTCR_1 = (entireSystemCollBefore
      .sub(gasComp_1))
      .mul(price)
      .div(entireSystemDebtBefore)

    assert.isTrue(expectedTCR_1.eq(TCR_1))

    const liquidationTx_2 = await troveManager.liquidate(defaulter_2)
    const [liquidatedDebt_2, liquidatedColl_2, gasComp_2] = th.getEmittedLiquidationValues(liquidationTx_2)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))

    const TCR_2 = await th.getTCR(contracts)

    const expectedTCR_2 = (entireSystemCollBefore
      .sub(gasComp_1)
      .sub(gasComp_2))
      .mul(price)
      .div(entireSystemDebtBefore)

    assert.isTrue(expectedTCR_2.eq(TCR_2))

    const liquidationTx_3 = await troveManager.liquidate(defaulter_3)
    const [liquidatedDebt_3, liquidatedColl_3, gasComp_3] = th.getEmittedLiquidationValues(liquidationTx_3)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_3)).eq(toBN('1')))

    const TCR_3 = await th.getTCR(contracts)

    const expectedTCR_3 = (entireSystemCollBefore
      .sub(gasComp_1)
      .sub(gasComp_2)
      .sub(gasComp_3))
      .mul(price)
      .div(entireSystemDebtBefore)

    assert.isTrue(expectedTCR_3.eq(TCR_3))


    const liquidationTx_4 = await troveManager.liquidate(defaulter_4)
    const [liquidatedDebt_4, liquidatedColl_4, gasComp_4] = th.getEmittedLiquidationValues(liquidationTx_4)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_4)).eq(toBN('1')))

    const TCR_4 = await th.getTCR(contracts)

    const expectedTCR_4 = (entireSystemCollBefore
      .sub(gasComp_1)
      .sub(gasComp_2)
      .sub(gasComp_3)
      .sub(gasComp_4))
      .mul(price)
      .div(entireSystemDebtBefore)

    assert.isTrue(expectedTCR_4.eq(TCR_4))
  })

  it("liquidate(): does not affect the SP deposit or ETH gain when called on an SP depositor's address that has no trove", async () => {
    await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    const spDeposit = toBN(dec(1, 24))
    await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: bob } })
    const { C_totalDebt, C_collateral } = await openTrove({ ICR: toBN(dec(218, 16)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: carol } })

    // Bob sends tokens to Dennis, who has no trove
    await debtToken.transfer(dennis, spDeposit, { from: bob })

    //Dennis provides LUSD to SP
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: dennis })

    // Carol gets liquidated
    await priceFeed.setPrice(dec(100, 18))
    const liquidationTX_C = await troveManager.liquidate(carol)
    const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTX_C)

    assert.isFalse((await troveManager.getTroveStatus(carol)).eq(toBN('1')))
    // Check Dennis' SP deposit has absorbed Carol's debt, and he has received her liquidated ETH
    const dennis_Deposit_Before = (await stabilityPool.getCompoundedDebtDeposit(dennis)).toString()
    const dennis_ETHGain_Before = (await stabilityPool.getDepositorETHGain(dennis)).toString()
    assert.isAtMost(th.getDifference(dennis_Deposit_Before, spDeposit.sub(liquidatedDebt)), 1000000)
    assert.isAtMost(th.getDifference(dennis_ETHGain_Before, liquidatedColl), 1000)

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Attempt to liquidate Dennis
    try {
      const txDennis = await troveManager.liquidate(dennis)
      assert.isFalse(txDennis.receipt.status)
    } catch (err) {
      assert.include(err.message, "revert")
      assert.include(err.message, "Trove does not exist or is closed")
    }

    // Check Dennis' SP deposit does not change after liquidation attempt
    const dennis_Deposit_After = (await stabilityPool.getCompoundedDebtDeposit(dennis)).toString()
    const dennis_ETHGain_After = (await stabilityPool.getDepositorETHGain(dennis)).toString()
    assert.equal(dennis_Deposit_Before, dennis_Deposit_After)
    assert.equal(dennis_ETHGain_Before, dennis_ETHGain_After)
  })

  it("liquidate(): does not liquidate a SP depositor's trove with ICR > 110%, and does not affect their SP deposit or ETH gain", async () => {
    await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    const spDeposit = toBN(dec(1, 24))
    await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(218, 16)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: carol } })

    //Bob provides LUSD to SP
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: bob })

    // Carol gets liquidated
    await priceFeed.setPrice(dec(100, 18))
    const liquidationTX_C = await troveManager.liquidate(carol)
    const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTX_C)
    assert.isFalse((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    // price bounces back - Bob's trove is >110% ICR again
    await priceFeed.setPrice(dec(200, 18))
    const price = await priceFeed.getPrice()
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt(mv._MCR))

    // Check Bob' SP deposit has absorbed Carol's debt, and he has received her liquidated ETH
    const bob_Deposit_Before = (await stabilityPool.getCompoundedDebtDeposit(bob)).toString()
    const bob_ETHGain_Before = (await stabilityPool.getDepositorETHGain(bob)).toString()
    assert.isAtMost(th.getDifference(bob_Deposit_Before, spDeposit.sub(liquidatedDebt)), 1000000)
    assert.isAtMost(th.getDifference(bob_ETHGain_Before, liquidatedColl), 1000)

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Attempt to liquidate Bob
    await assertRevert(troveManager.liquidate(bob), "TroveManager: nothing to liquidate")

    // Confirm Bob's trove is still active
    assert.isTrue((await troveManager.getTroveStatus(bob)).eq(toBN('1')))

    // Check Bob' SP deposit does not change after liquidation attempt
    const bob_Deposit_After = (await stabilityPool.getCompoundedDebtDeposit(bob)).toString()
    const bob_ETHGain_After = (await stabilityPool.getDepositorETHGain(bob)).toString()
    assert.equal(bob_Deposit_Before, bob_Deposit_After)
    assert.equal(bob_ETHGain_Before, bob_ETHGain_After)
  })

  it("liquidate(): liquidates a SP depositor's trove with ICR < 110%, and the liquidation correctly impacts their SP deposit and ETH gain", async () => {
    const A_spDeposit = toBN(dec(3, 24))
    const B_spDeposit = toBN(dec(1, 24))
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
    await openTrove({ ICR: toBN(dec(8, 18)), extraLUSDAmount: A_spDeposit, extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_debt } = await openTrove({ ICR: toBN(dec(218, 16)), extraLUSDAmount: B_spDeposit, extraParams: { from: bob } })
    const { collateral: C_collateral, totalDebt: C_debt } = await openTrove({ ICR: toBN(dec(210, 16)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: carol } })

    //Bob provides LUSD to SP
    await stabilityPool.provideToSP(B_spDeposit, ZERO_ADDRESS, { from: bob })

    // Carol gets liquidated
    await priceFeed.setPrice(dec(100, 18))
    await troveManager.liquidate(carol)

    // Check Bob' SP deposit has absorbed Carol's debt, and he has received her liquidated ETH
    const bob_Deposit_Before = await stabilityPool.getCompoundedDebtDeposit(bob)
    const bob_ETHGain_Before = await stabilityPool.getDepositorETHGain(bob)
    assert.isAtMost(th.getDifference(bob_Deposit_Before, B_spDeposit.sub(C_debt)), 1000000)
    assert.isAtMost(th.getDifference(bob_ETHGain_Before, th.applyLiquidationFee(C_collateral)), 1000)

    // Alice provides LUSD to SP
    await stabilityPool.provideToSP(A_spDeposit, ZERO_ADDRESS, { from: alice })

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Liquidate Bob
    await troveManager.liquidate(bob)

    // Confirm Bob's trove has been closed
    const bob_Trove_Status = ((await troveManager.Troves(bob))[3]).toString()
    assert.equal(bob_Trove_Status, 3) // check closed by liquidation

    /* Alice's LUSD Loss = (300 / 400) * 200 = 150 LUSD
       Alice's ETH gain = (300 / 400) * 2*0.995 = 1.4925 ETH

       Bob's LUSDLoss = (100 / 400) * 200 = 50 LUSD
       Bob's ETH gain = (100 / 400) * 2*0.995 = 0.4975 ETH

     Check Bob' SP deposit has been reduced to 50 LUSD, and his ETH gain has increased to 1.5 ETH. */
    const alice_Deposit_After = (await stabilityPool.getCompoundedDebtDeposit(alice)).toString()
    const alice_ETHGain_After = (await stabilityPool.getDepositorETHGain(alice)).toString()

    const totalDeposits = bob_Deposit_Before.add(A_spDeposit)

    assert.isAtMost(th.getDifference(alice_Deposit_After, A_spDeposit.sub(B_debt.mul(A_spDeposit).div(totalDeposits))), 1100000)
    assert.isAtMost(th.getDifference(alice_ETHGain_After, th.applyLiquidationFee(B_collateral).mul(A_spDeposit).div(totalDeposits)), 2200000)

    const bob_Deposit_After = await stabilityPool.getCompoundedDebtDeposit(bob)
    const bob_ETHGain_After = await stabilityPool.getDepositorETHGain(bob)

    assert.isAtMost(th.getDifference(bob_Deposit_After, bob_Deposit_Before.sub(B_debt.mul(bob_Deposit_Before).div(totalDeposits))), 1000000)
    assert.isAtMost(th.getDifference(bob_ETHGain_After, bob_ETHGain_Before.add(th.applyLiquidationFee(B_collateral).mul(bob_Deposit_Before).div(totalDeposits))), 1000000)
  })

  it("liquidate(): does not alter the liquidated user's token balance", async () => {
    await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    const { debtAmount: A_lusdAmount } = await openTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: toBN(dec(300, 18)), extraParams: { from: alice } })
    const { debtAmount: B_lusdAmount } = await openTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: toBN(dec(200, 18)), extraParams: { from: bob } })
    const { debtAmount: C_lusdAmount } = await openTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: carol } })

    await priceFeed.setPrice(dec(100, 18))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Liquidate A, B and C
    const activeLUSDDebt_0 = await activePool.getLUSDDebt()
    const defaultLUSDDebt_0 = await defaultPool.getLUSDDebt()

    await troveManager.liquidate(alice)
    const activeLUSDDebt_A = await activePool.getLUSDDebt()
    const defaultLUSDDebt_A = await defaultPool.getLUSDDebt()

    await troveManager.liquidate(bob)
    const activeLUSDDebt_B = await activePool.getLUSDDebt()
    const defaultLUSDDebt_B = await defaultPool.getLUSDDebt()

    await troveManager.liquidate(carol)

    // Confirm A, B, C closed
    assert.isFalse((await troveManager.getTroveStatus(alice)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(bob)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    // Confirm token balances have not changed
    assert.equal((await debtToken.balanceOf(alice)).toString(), A_lusdAmount)
    assert.equal((await debtToken.balanceOf(bob)).toString(), B_lusdAmount)
    assert.equal((await debtToken.balanceOf(carol)).toString(), C_lusdAmount)
  })

  it("liquidate(): liquidates based on entire/collateral debt (including pending rewards), not raw collateral/debt", async () => {
    await openTrove({ ICR: toBN(dec(8, 18)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(221, 16)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: carol } })

    // Defaulter opens with 60 LUSD, 0.6 ETH
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    const alice_ICR_Before = await troveManager.getCurrentICR(alice, price)
    const bob_ICR_Before = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_Before = await troveManager.getCurrentICR(carol, price)

    /* Before liquidation: 
    Alice ICR: = (2 * 100 / 50) = 400%
    Bob ICR: (1 * 100 / 90.5) = 110.5%
    Carol ICR: (1 * 100 / 100 ) =  100%

    Therefore Alice and Bob above the MCR, Carol is below */
    assert.isTrue(alice_ICR_Before.gte(mv._MCR))
    assert.isTrue(bob_ICR_Before.gte(mv._MCR))
    assert.isTrue(carol_ICR_Before.lte(mv._MCR))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    /* Liquidate defaulter. 30 LUSD and 0.3 ETH is distributed between A, B and C.

    A receives (30 * 2/4) = 15 LUSD, and (0.3*2/4) = 0.15 ETH
    B receives (30 * 1/4) = 7.5 LUSD, and (0.3*1/4) = 0.075 ETH
    C receives (30 * 1/4) = 7.5 LUSD, and (0.3*1/4) = 0.075 ETH
    */
    await troveManager.liquidate(defaulter_1)

    const alice_ICR_After = await troveManager.getCurrentICR(alice, price)
    const bob_ICR_After = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_After = await troveManager.getCurrentICR(carol, price)

    /* After liquidation: 

    Alice ICR: (10.15 * 100 / 60) = 183.33%
    Bob ICR:(1.075 * 100 / 98) =  109.69%
    Carol ICR: (1.075 *100 /  107.5 ) = 100.0%

    Check Alice is above MCR, Bob below, Carol below. */


    assert.isTrue(alice_ICR_After.gte(mv._MCR))
    assert.isTrue(bob_ICR_After.lte(mv._MCR))
    assert.isTrue(carol_ICR_After.lte(mv._MCR))

    /* Though Bob's true ICR (including pending rewards) is below the MCR, 
    check that Bob's raw coll and debt has not changed, and that his "raw" ICR is above the MCR */
    const bob_Coll = (await troveManager.Troves(bob))[1]
    const bob_Debt = (await troveManager.Troves(bob))[0]

    const bob_rawICR = bob_Coll.mul(toBN(dec(100, 18))).div(bob_Debt)
    assert.isTrue(bob_rawICR.gte(mv._MCR))

    // Whale enters system, pulling it into Normal Mode
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate Alice, Bob, Carol
    await assertRevert(troveManager.liquidate(alice), "TroveManager: nothing to liquidate")
    await troveManager.liquidate(bob)
    await troveManager.liquidate(carol)

    // Check trove statuses - A active (1),  B and C liquidated (3)
    assert.equal((await troveManager.Troves(alice))[3].toString(), '1')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')
  })

  it("liquidate(): when SP > 0, triggers SATO reward event - increases the sum G", async () => {
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves 
    await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: C } })

    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })
    assert.equal(await stabilityPool.getTotalDebtDeposits(), dec(100, 18))

    const G_Before = await stabilityPool.epochToScaleToG(0, 0)

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // Price drops to 1ETH:100LUSD, reducing defaulters to below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate trove
    await troveManager.liquidate(defaulter_1)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))

    const G_After = await stabilityPool.epochToScaleToG(0, 0)

    // Expect G has increased from the SATO reward event triggered
    assert.isTrue(G_After.gt(G_Before))
  })

  it("liquidate(): when SP is empty, doesn't update G", async () => {
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves 
    await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: C } })

    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // B withdraws
    let _spWithdrawAmt = dec(100, 18);
    await stabilityPool.requestWithdrawFromSP(_spWithdrawAmt, { from: B })
	await th.fastForwardTime(timeValues.SECONDS_IN_TWO_HOURS + 123, web3.currentProvider)
    await stabilityPool.withdrawFromSP(_spWithdrawAmt, { from: B })

    // Check SP is empty
    assert.equal((await stabilityPool.getTotalDebtDeposits()), '0')

    // Check G is non-zero
    const G_Before = await stabilityPool.epochToScaleToG(0, 0)
    assert.isTrue(G_Before.gt(toBN('0')))

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // Price drops to 1ETH:100LUSD, reducing defaulters to below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // liquidate trove
    await troveManager.liquidate(defaulter_1)
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))

    const G_After = await stabilityPool.epochToScaleToG(0, 0)

    // Expect G has not changed
    assert.isTrue(G_After.eq(G_Before))
  })

  // --- liquidateTroves() ---

  it('liquidateTroves(): liquidates a Trove that a) was skipped in a previous liquidation and b) has pending rewards', async () => {
    // A, B, C, D, E open troves
    await openTrove({ ICR: toBN(dec(333, 16)), extraParams: { from: D } })
    await openTrove({ ICR: toBN(dec(333, 16)), extraParams: { from: E } })
    await openTrove({ ICR: toBN(dec(120, 16)), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: C } })

    // Price drops
    await priceFeed.setPrice(dec(175, 18))
    let price = await priceFeed.getPrice()
    
    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // A gets liquidated, creates pending rewards for all
    const liqTxA = await troveManager.liquidate(A)
    assert.isTrue(liqTxA.receipt.status)
    assert.isFalse((await troveManager.getTroveStatus(A)).eq(toBN('1')))

    // A adds 10 LUSD to the SP, but less than C's debt
    await stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, {from: A})

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    price = await priceFeed.getPrice()
    // Confirm system is now in Recovery Mode
    assert.isTrue(await th.checkRecoveryMode(contracts))

    // Confirm C has ICR > TCR
    const TCR = await troveManager.getTCR(price)
    const ICR_C = await troveManager.getCurrentICR(C, price)
  
    assert.isTrue(ICR_C.gt(TCR))

    // Attempt to liquidate B and C, which skips C in the liquidation since it is immune
    const liqTxBC = await troveManager.batchLiquidateTroves([B,C])
    assert.isTrue(liqTxBC.receipt.status)
    assert.isFalse((await troveManager.getTroveStatus(B)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(C)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(D)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(E)).eq(toBN('1')))

    // // All remaining troves D and E repay a little debt, applying their pending rewards
    await borrowerOperations.repayDebt(dec(1, 18), {from: D})
    await borrowerOperations.repayDebt(dec(1, 18), {from: E})

    // Check C is the only trove that has pending rewards
    assert.isTrue(await troveManager.hasPendingRewards(C))
    assert.isFalse(await troveManager.hasPendingRewards(D))
    assert.isFalse(await troveManager.hasPendingRewards(E))

    // Check C's pending coll and debt rewards are <= the coll and debt in the DefaultPool
    const pendingETH_C = await troveManager.getPendingETHReward(C)
    const pendingLUSDDebt_C = await troveManager.getPendingLUSDDebtReward(C)
    const defaultPoolETH = await defaultPool.getETH()
    const defaultPoolLUSDDebt = await defaultPool.getLUSDDebt()
    assert.isTrue(pendingETH_C.lte(defaultPoolETH))
    assert.isTrue(pendingLUSDDebt_C.lte(defaultPoolLUSDDebt))
    //Check only difference is dust
    assert.isAtMost(th.getDifference(pendingETH_C, defaultPoolETH), 1000)
    assert.isAtMost(th.getDifference(pendingLUSDDebt_C, defaultPoolLUSDDebt), 1000)

    // Confirm system is still in Recovery Mode
    assert.isTrue(await th.checkRecoveryMode(contracts))

    // D and E fill the Stability Pool, enough to completely absorb C's debt of 70
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, {from: D})
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, {from: E})

    await priceFeed.setPrice(dec(50, 18))

    // Try to liquidate C again. Check it succeeds and closes C's trove
    const liqTx2 = await troveManager.batchLiquidateTroves([D,C])
    assert.isTrue(liqTx2.receipt.status)
    assert.isFalse((await troveManager.getTroveStatus(C)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(D)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(E)).eq(toBN('1')))
  })

  it('liquidateTroves(): closes every Trove with ICR < MCR, when n > number of undercollateralized troves', async () => {
    // --- SETUP ---
    await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

    // create 5 Troves with varying ICRs
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: erin } })
    await openTrove({ ICR: toBN(dec(120, 16)), extraParams: { from: flyn } })

    // G,H, I open high-ICR troves
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: graham } })
    await openTrove({ ICR: toBN(dec(90, 18)), extraParams: { from: harriet } })
    await openTrove({ ICR: toBN(dec(80, 18)), extraParams: { from: ida } })

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1ETH:100LUSD, reducing Bob and Carol's ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Confirm troves A-E are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).lte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(flyn, price)).lte(mv._MCR))

    // Confirm troves G, H, I are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(graham, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(harriet, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(ida, price)).gte(mv._MCR))

    // Confirm Whale is ICR > 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    // Liquidate 5 troves
    await troveManager.batchLiquidateTroves([alice,bob,carol,erin,flyn]);

    // Check all troves A-E are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')
    assert.equal((await troveManager.Troves(erin))[3].toString(), '3')
    assert.equal((await troveManager.Troves(flyn))[3].toString(), '3')
  })

  it('liquidateTroves(): liquidates  up to the requested number of undercollateralized troves', async () => {
    // --- SETUP --- 
    await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol, Dennis, Erin open troves with consecutively decreasing collateral ratio
    await openTrove({ ICR: toBN(dec(202, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(204, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(206, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(208, 16)), extraParams: { from: dennis } })
    await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: erin } })

    // --- TEST --- 

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    await troveManager.batchLiquidateTroves([alice,bob,carol])

    const TroveOwnersArrayLength = await troveManager.getTroveOwnersCount()
    assert.equal(TroveOwnersArrayLength, '3')

    // Check Alice, Bob, Carol troves have been closed
    const aliceTroveStatus = (await troveManager.getTroveStatus(alice)).toString()
    const bobTroveStatus = (await troveManager.getTroveStatus(bob)).toString()
    const carolTroveStatus = (await troveManager.getTroveStatus(carol)).toString()

    assert.equal(aliceTroveStatus, '3')
    assert.equal(bobTroveStatus, '3')
    assert.equal(carolTroveStatus, '3')

    //  Check Alice, Bob, and Carol's trove no longer exist
    assert.isFalse((await troveManager.getTroveStatus(alice)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(bob)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    // Check Dennis, Erin still have active troves
    const dennisTroveStatus = (await troveManager.getTroveStatus(dennis)).toString()
    const erinTroveStatus = (await troveManager.getTroveStatus(erin)).toString()

    assert.equal(dennisTroveStatus, '1')
    assert.equal(erinTroveStatus, '1')
  })

  it('liquidateTroves(): does nothing if all troves have ICR > 110%', async () => {
    await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    await openTrove({ ICR: toBN(dec(222, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(222, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(222, 16)), extraParams: { from: carol } })

    // Price drops, but all troves remain active at 111% ICR
    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    assert.isTrue((await troveManager.getTroveStatus(whale)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(alice)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(bob)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    const TCR_Before = (await th.getTCR(contracts)).toString()

    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).gte(mv._MCR))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Attempt liqudation sequence
    await assertRevert(troveManager.batchLiquidateTroves([whale,alice,bob,carol]), "TroveManager: nothing to liquidate")

    // Check all troves remain active
    assert.isTrue((await troveManager.getTroveStatus(whale)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(alice)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(bob)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    const TCR_After = (await th.getTCR(contracts)).toString()

    assert.equal(TCR_Before, TCR_After)
  })

  
  it("liquidateTroves(): liquidates based on entire/collateral debt (including pending rewards), not raw collateral/debt", async () => {
    await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(221, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_1 } })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    const alice_ICR_Before = await troveManager.getCurrentICR(alice, price)
    const bob_ICR_Before = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_Before = await troveManager.getCurrentICR(carol, price)

    /* Before liquidation: 
    Alice ICR: = (2 * 100 / 100) = 200%
    Bob ICR: (1 * 100 / 90.5) = 110.5%
    Carol ICR: (1 * 100 / 100 ) =  100%

    Therefore Alice and Bob above the MCR, Carol is below */
    assert.isTrue(alice_ICR_Before.gte(mv._MCR))
    assert.isTrue(bob_ICR_Before.gte(mv._MCR))
    assert.isTrue(carol_ICR_Before.lte(mv._MCR))

    // Liquidate defaulter. 30 LUSD and 0.3 ETH is distributed uniformly between A, B and C. Each receive 10 LUSD, 0.1 ETH
    await troveManager.liquidate(defaulter_1)

    const alice_ICR_After = await troveManager.getCurrentICR(alice, price)
    const bob_ICR_After = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_After = await troveManager.getCurrentICR(carol, price)

    /* After liquidation: 

    Alice ICR: (1.0995 * 100 / 60) = 183.25%
    Bob ICR:(1.0995 * 100 / 100.5) =  109.40%
    Carol ICR: (1.0995 * 100 / 110 ) 99.95%

    Check Alice is above MCR, Bob below, Carol below. */
    assert.isTrue(alice_ICR_After.gte(mv._MCR))
    assert.isTrue(bob_ICR_After.lte(mv._MCR))
    assert.isTrue(carol_ICR_After.lte(mv._MCR))

    /* Though Bob's true ICR (including pending rewards) is below the MCR, check that Bob's raw coll and debt has not changed */
    const bob_Coll = (await troveManager.Troves(bob))[1]
    const bob_Debt = (await troveManager.Troves(bob))[0]

    const bob_rawICR = bob_Coll.mul(toBN(dec(100, 18))).div(bob_Debt)
    assert.isTrue(bob_rawICR.gte(mv._MCR))

    // Whale enters system, pulling it into Normal Mode
    await openTrove({ ICR: toBN(dec(10, 18)), extraLUSDAmount: dec(1, 24), extraParams: { from: whale } })

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    //liquidate A, B, C
    await troveManager.batchLiquidateTroves([alice,bob,carol])

    // check trove statuses - A active (1),  B and C closed by liquidation (3)
    assert.equal((await troveManager.Troves(alice))[3].toString(), '1')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')
  })

  it("liquidateTroves(): reverts if n = 0", async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
    await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(206, 16)), extraParams: { from: carol } })

    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    const TCR_Before = (await th.getTCR(contracts)).toString()

    // Confirm A, B, C ICRs are below 110%
    const alice_ICR = await troveManager.getCurrentICR(alice, price)
    const bob_ICR = await troveManager.getCurrentICR(bob, price)
    const carol_ICR = await troveManager.getCurrentICR(carol, price)
    assert.isTrue(alice_ICR.lte(mv._MCR))
    assert.isTrue(bob_ICR.lte(mv._MCR))
    assert.isTrue(carol_ICR.lte(mv._MCR))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Liquidation with n = 0
    await assertRevert(troveManager.batchLiquidateTroves([]), "TroveManager: nothing to liquidate")

    // Check all troves are still in the system
    assert.isTrue((await troveManager.getTroveStatus(whale)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(alice)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(bob)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    const TCR_After = (await th.getTCR(contracts)).toString()

    // Check TCR has not changed after liquidation
    assert.equal(TCR_Before, TCR_After)
  })

  it("liquidateTroves():  liquidates troves with ICR < MCR", async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // A, B, C open troves that will remain active when price drops to 100
    await openTrove({ ICR: toBN(dec(220, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(230, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(240, 16)), extraParams: { from: carol } })

    // D, E, F open troves that will fall below MCR when price drops to 100
    await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: dennis } })
    await openTrove({ ICR: toBN(dec(216, 16)), extraParams: { from: erin } })
    await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: flyn } })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    const alice_ICR = await troveManager.getCurrentICR(alice, price)
    const bob_ICR = await troveManager.getCurrentICR(bob, price)
    const carol_ICR = await troveManager.getCurrentICR(carol, price)
    const dennis_ICR = await troveManager.getCurrentICR(dennis, price)
    const erin_ICR = await troveManager.getCurrentICR(erin, price)
    const flyn_ICR = await troveManager.getCurrentICR(flyn, price)

    // Check A, B, C have ICR above MCR
    assert.isTrue(alice_ICR.gte(mv._MCR))
    assert.isTrue(bob_ICR.gte(mv._MCR))
    assert.isTrue(carol_ICR.gte(mv._MCR))

    // Check D, E, F have ICR below MCR
    assert.isTrue(dennis_ICR.lte(mv._MCR))
    assert.isTrue(erin_ICR.lte(mv._MCR))
    assert.isTrue(flyn_ICR.lte(mv._MCR))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    //Liquidate sequence
    await troveManager.batchLiquidateTroves([whale,alice,bob,carol,dennis,erin,flyn])

    // Check Whale and A, B, C remain in the system
    assert.isTrue((await troveManager.getTroveStatus(whale)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(alice)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(bob)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    // Check D, E, F have been removed
    assert.isFalse((await troveManager.getTroveStatus(dennis)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(erin)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(flyn)).eq(toBN('1')))
  })

  it("liquidateTroves(): does not affect the liquidated user's token balances", async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // D, E, F open troves that will fall below MCR when price drops to 100
    await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: dennis } })
    await openTrove({ ICR: toBN(dec(216, 16)), extraParams: { from: erin } })
    await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: flyn } })

    const D_balanceBefore = await debtToken.balanceOf(dennis)
    const E_balanceBefore = await debtToken.balanceOf(erin)
    const F_balanceBefore = await debtToken.balanceOf(flyn)

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    //Liquidate sequence
    await troveManager.batchLiquidateTroves([whale,dennis,erin,flyn])

    // Check Whale remains in the system
    assert.isTrue((await troveManager.getTroveStatus(whale)).eq(toBN('1')))

    // Check D, E, F have been removed
    assert.isFalse((await troveManager.getTroveStatus(dennis)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(erin)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(flyn)).eq(toBN('1')))

    // Check token balances of users whose troves were liquidated, have not changed
    assert.equal((await debtToken.balanceOf(dennis)).toString(), D_balanceBefore)
    assert.equal((await debtToken.balanceOf(erin)).toString(), E_balanceBefore)
    assert.equal((await debtToken.balanceOf(flyn)).toString(), F_balanceBefore)
  })

  it("liquidateTroves(): A liquidation sequence containing Pool offsets increases the TCR", async () => {
    // Whale provides 500 LUSD to SP
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: toBN(dec(500, 18)), extraParams: { from: whale } })
    await stabilityPool.provideToSP(dec(500, 18), ZERO_ADDRESS, { from: whale })

    await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(28, 18)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(80, 18)), extraParams: { from: dennis } })

    await openTrove({ ICR: toBN(dec(199, 16)), extraParams: { from: defaulter_1 } })
    await openTrove({ ICR: toBN(dec(156, 16)), extraParams: { from: defaulter_2 } })
    await openTrove({ ICR: toBN(dec(183, 16)), extraParams: { from: defaulter_3 } })
    await openTrove({ ICR: toBN(dec(166, 16)), extraParams: { from: defaulter_4 } })

    assert.isTrue((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_3)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_4)).eq(toBN('1')))

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    const TCR_Before = await th.getTCR(contracts)

    // Check pool has 500 LUSD
    assert.equal((await stabilityPool.getTotalDebtDeposits()).toString(), dec(500, 18))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Liquidate troves
    await troveManager.batchLiquidateTroves([whale,alice,bob,carol,dennis,defaulter_1,defaulter_2,defaulter_3,defaulter_4])

    // Check pool has been emptied by the liquidations
    assert.equal((await stabilityPool.getTotalDebtDeposits()).toString(), '0')

    // Check all defaulters have been liquidated
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(defaulter_3)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(defaulter_4)).eq(toBN('1')))

    // Check that the liquidation sequence has improved the TCR
    const TCR_After = await th.getTCR(contracts)
    assert.isTrue(TCR_After.gte(TCR_Before))
  })

  it("liquidateTroves(): A liquidation sequence of pure redistributions decreases the TCR, due to gas compensation, but up to 0.5%", async () => {
    const { collateral: W_coll, totalDebt: W_debt } = await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })
    const { collateral: A_coll, totalDebt: A_debt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_coll, totalDebt: B_debt } = await openTrove({ ICR: toBN(dec(28, 18)), extraParams: { from: bob } })
    const { collateral: C_coll, totalDebt: C_debt } = await openTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: carol } })
    const { collateral: D_coll, totalDebt: D_debt } = await openTrove({ ICR: toBN(dec(80, 18)), extraParams: { from: dennis } })

    const { collateral: d1_coll, totalDebt: d1_debt } = await openTrove({ ICR: toBN(dec(199, 16)), extraParams: { from: defaulter_1 } })
    const { collateral: d2_coll, totalDebt: d2_debt } = await openTrove({ ICR: toBN(dec(156, 16)), extraParams: { from: defaulter_2 } })
    const { collateral: d3_coll, totalDebt: d3_debt } = await openTrove({ ICR: toBN(dec(183, 16)), extraParams: { from: defaulter_3 } })
    const { collateral: d4_coll, totalDebt: d4_debt } = await openTrove({ ICR: toBN(dec(166, 16)), extraParams: { from: defaulter_4 } })

    const totalCollNonDefaulters = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)
    const totalCollDefaulters = d1_coll.add(d2_coll).add(d3_coll).add(d4_coll)
    const totalColl = totalCollNonDefaulters.add(totalCollDefaulters)
    const totalDebt = W_debt.add(A_debt).add(B_debt).add(C_debt).add(D_debt).add(d1_debt).add(d2_debt).add(d3_debt).add(d4_debt)

    assert.isTrue((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_3)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(defaulter_4)).eq(toBN('1')))

    // Price drops
    const price = toBN(dec(100, 18))
    await priceFeed.setPrice(price)

    const TCR_Before = await th.getTCR(contracts)
    assert.isAtMost(th.getDifference(TCR_Before, totalColl.mul(price).div(totalDebt)), 1000)

    // Check pool is empty before liquidation
    assert.equal((await stabilityPool.getTotalDebtDeposits()).toString(), '0')

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Liquidate
    await troveManager.batchLiquidateTroves([whale,alice,bob,carol,dennis,defaulter_1,defaulter_2,defaulter_3,defaulter_4])

    // Check all defaulters have been liquidated
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(defaulter_3)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(defaulter_4)).eq(toBN('1')))

    // Check that the liquidation sequence has reduced the TCR
    const TCR_After = await th.getTCR(contracts)
    // ((100+1+7+2+20)+(1+2+3+4)*0.995)*100/(2050+50+50+50+50+101+257+328+480)
    assert.isAtMost(th.getDifference(TCR_After, totalCollNonDefaulters.add(th.applyLiquidationFee(totalCollDefaulters)).mul(price).div(totalDebt)), 1000)
    assert.isTrue(TCR_Before.gte(TCR_After))
    assert.isTrue(TCR_After.gte(TCR_Before.mul(toBN(995)).div(toBN(1000))))
  })

  it("liquidateTroves(): Liquidating troves with SP deposits correctly impacts their SP deposit and ETH gain", async () => {
    // Whale provides 400 LUSD to the SP
    const whaleDeposit = toBN(dec(40000, 18))
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: whaleDeposit, extraParams: { from: whale } })
    await stabilityPool.provideToSP(whaleDeposit, ZERO_ADDRESS, { from: whale })

    const A_deposit = toBN(dec(10000, 18))
    const B_deposit = toBN(dec(30000, 18))
    const { collateral: A_coll, totalDebt: A_debt } = await openTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: A_deposit, extraParams: { from: alice } })
    const { collateral: B_coll, totalDebt: B_debt } = await openTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: B_deposit, extraParams: { from: bob } })
    const { collateral: C_coll, totalDebt: C_debt } = await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

    const liquidatedColl = A_coll.add(B_coll).add(C_coll)
    const liquidatedDebt = A_debt.add(B_debt).add(C_debt)

    // A, B provide 100, 300 to the SP
    await stabilityPool.provideToSP(A_deposit, ZERO_ADDRESS, { from: alice })
    await stabilityPool.provideToSP(B_deposit, ZERO_ADDRESS, { from: bob })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    // Check 800 LUSD in Pool
    const totalDeposits = whaleDeposit.add(A_deposit).add(B_deposit)
    assert.equal((await stabilityPool.getTotalDebtDeposits()).toString(), totalDeposits)

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Liquidate
    await troveManager.batchLiquidateTroves([whale,alice,bob,carol])

    // Check all defaulters have been liquidated
    assert.isFalse((await troveManager.getTroveStatus(alice)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(bob)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    /* Prior to liquidation, SP deposits were:
    Whale: 400 LUSD
    Alice: 100 LUSD
    Bob:   300 LUSD
    Carol: 0 LUSD

    Total LUSD in Pool: 800 LUSD

    Then, liquidation hits A,B,C: 

    Total liquidated debt = 150 + 350 + 150 = 650 LUSD
    Total liquidated ETH = 1.1 + 3.1 + 1.1 = 5.3 ETH

    whale lusd loss: 650 * (400/800) = 325 lusd
    alice lusd loss:  650 *(100/800) = 81.25 lusd
    bob lusd loss: 650 * (300/800) = 243.75 lusd

    whale remaining deposit: (400 - 325) = 75 lusd
    alice remaining deposit: (100 - 81.25) = 18.75 lusd
    bob remaining deposit: (300 - 243.75) = 56.25 lusd

    whale eth gain: 5*0.995 * (400/800) = 2.4875 eth
    alice eth gain: 5*0.995 *(100/800) = 0.621875 eth
    bob eth gain: 5*0.995 * (300/800) = 1.865625 eth

    Total remaining deposits: 150 LUSD
    Total ETH gain: 4.975 ETH */

    // Check remaining LUSD Deposits and ETH gain, for whale and depositors whose troves were liquidated
    const whale_Deposit_After = await stabilityPool.getCompoundedDebtDeposit(whale)
    const alice_Deposit_After = await stabilityPool.getCompoundedDebtDeposit(alice)
    const bob_Deposit_After = await stabilityPool.getCompoundedDebtDeposit(bob)

    const whale_ETHGain = await stabilityPool.getDepositorETHGain(whale)
    const alice_ETHGain = await stabilityPool.getDepositorETHGain(alice)
    const bob_ETHGain = await stabilityPool.getDepositorETHGain(bob)

    assert.isAtMost(th.getDifference(whale_Deposit_After, whaleDeposit.sub(liquidatedDebt.mul(whaleDeposit).div(totalDeposits))), 100000)
    assert.isAtMost(th.getDifference(alice_Deposit_After, A_deposit.sub(liquidatedDebt.mul(A_deposit).div(totalDeposits))), 100000)
    assert.isAtMost(th.getDifference(bob_Deposit_After, B_deposit.sub(liquidatedDebt.mul(B_deposit).div(totalDeposits))), 100000)

    assert.isAtMost(th.getDifference(whale_ETHGain, th.applyLiquidationFee(liquidatedColl).mul(whaleDeposit).div(totalDeposits)), 100000)
    assert.isAtMost(th.getDifference(alice_ETHGain, th.applyLiquidationFee(liquidatedColl).mul(A_deposit).div(totalDeposits)), 100000)
    assert.isAtMost(th.getDifference(bob_ETHGain, th.applyLiquidationFee(liquidatedColl).mul(B_deposit).div(totalDeposits)), 100000)

    // Check total remaining deposits and ETH gain in Stability Pool
    const total_LUSDinSP = (await stabilityPool.getTotalDebtDeposits()).toString()
    const total_ETHinSP = (await stabilityPool.getETH()).toString()

    assert.isAtMost(th.getDifference(total_LUSDinSP, totalDeposits.sub(liquidatedDebt)), 1000)
    assert.isAtMost(th.getDifference(total_ETHinSP, th.applyLiquidationFee(liquidatedColl)), 1000)
  })

  it("liquidateTroves(): when SP > 0, triggers SATO reward event - increases the sum G", async () => {
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves
    await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: C } })

    await openTrove({ ICR: toBN(dec(219, 16)), extraParams: { from: defaulter_1 } })
    await openTrove({ ICR: toBN(dec(213, 16)), extraParams: { from: defaulter_2 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })
    assert.equal(await stabilityPool.getTotalDebtDeposits(), dec(100, 18))

    const G_Before = await stabilityPool.epochToScaleToG(0, 0)

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // Price drops to 1ETH:100LUSD, reducing defaulters to below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate troves
    await troveManager.batchLiquidateTroves([defaulter_1,defaulter_2])
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))

    const G_After = await stabilityPool.epochToScaleToG(0, 0)

    // Expect G has increased from the SATO reward event triggered
    assert.isTrue(G_After.gt(G_Before))
  })

  it("liquidateTroves(): when SP is empty, doesn't update G", async () => {
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves
    await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: C } })

    await openTrove({ ICR: toBN(dec(219, 16)), extraParams: { from: defaulter_1 } })
    await openTrove({ ICR: toBN(dec(213, 16)), extraParams: { from: defaulter_2 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // B withdraws
    let _spWithdrawAmt = dec(100, 18);
    await stabilityPool.requestWithdrawFromSP(_spWithdrawAmt, { from: B })
	await th.fastForwardTime(timeValues.SECONDS_IN_TWO_HOURS + 123, web3.currentProvider)
    await stabilityPool.withdrawFromSP(_spWithdrawAmt, { from: B })

    // Check SP is empty
    assert.equal((await stabilityPool.getTotalDebtDeposits()), '0')

    // Check G is non-zero
    const G_Before = await stabilityPool.epochToScaleToG(0, 0)
    assert.isTrue(G_Before.gt(toBN('0')))

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // Price drops to 1ETH:100LUSD, reducing defaulters to below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // liquidate troves
    await troveManager.batchLiquidateTroves([defaulter_1,defaulter_2])
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))

    const G_After = await stabilityPool.epochToScaleToG(0, 0)

    // Expect G has not changed
    assert.isTrue(G_After.eq(G_Before))
  })


  // --- batchLiquidateTroves() ---

  it('batchLiquidateTroves(): liquidates a Trove that a) was skipped in a previous liquidation and b) has pending rewards', async () => {
    // A, B, C, D, E open troves 
    await openTrove({ ICR: toBN(dec(300, 16)), extraParams: { from: C } })
    await openTrove({ ICR: toBN(dec(364, 16)), extraParams: { from: D } })
    await openTrove({ ICR: toBN(dec(364, 16)), extraParams: { from: E } })
    await openTrove({ ICR: toBN(dec(120, 16)), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: B } })

    // Price drops
    await priceFeed.setPrice(dec(175, 18))
    let price = await priceFeed.getPrice()
    
    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // A gets liquidated, creates pending rewards for all
    const liqTxA = await troveManager.liquidate(A)
    assert.isTrue(liqTxA.receipt.status)
    assert.isFalse((await troveManager.getTroveStatus(A)).eq(toBN('1')))

    // A adds 10 LUSD to the SP, but less than C's debt
    await stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, {from: A})

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    price = await priceFeed.getPrice()
    // Confirm system is now in Recovery Mode
    assert.isTrue(await th.checkRecoveryMode(contracts))

    // Confirm C has ICR > TCR
    const TCR = await troveManager.getTCR(price)
    const ICR_C = await troveManager.getCurrentICR(C, price)
  
    assert.isTrue(ICR_C.gt(TCR))

    // Attempt to liquidate B and C, which skips C in the liquidation since it is immune
    const liqTxBC = await troveManager.batchLiquidateTroves([B,C])
    assert.isTrue(liqTxBC.receipt.status)
    assert.isFalse((await troveManager.getTroveStatus(B)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(C)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(D)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(E)).eq(toBN('1')))

    // // All remaining troves D and E repay a little debt, applying their pending rewards
    await borrowerOperations.repayDebt(dec(1, 18), {from: D})
    await borrowerOperations.repayDebt(dec(1, 18), {from: E})

    // Check C is the only trove that has pending rewards
    assert.isTrue(await troveManager.hasPendingRewards(C))
    assert.isFalse(await troveManager.hasPendingRewards(D))
    assert.isFalse(await troveManager.hasPendingRewards(E))

    // Check C's pending coll and debt rewards are <= the coll and debt in the DefaultPool
    const pendingETH_C = await troveManager.getPendingETHReward(C)
    const pendingLUSDDebt_C = await troveManager.getPendingLUSDDebtReward(C)
    const defaultPoolETH = await defaultPool.getETH()
    const defaultPoolLUSDDebt = await defaultPool.getLUSDDebt()
    assert.isTrue(pendingETH_C.lte(defaultPoolETH))
    assert.isTrue(pendingLUSDDebt_C.lte(defaultPoolLUSDDebt))
    //Check only difference is dust
    assert.isAtMost(th.getDifference(pendingETH_C, defaultPoolETH), 1000)
    assert.isAtMost(th.getDifference(pendingLUSDDebt_C, defaultPoolLUSDDebt), 1000)

    // Confirm system is still in Recovery Mode
    assert.isTrue(await th.checkRecoveryMode(contracts))

    // D and E fill the Stability Pool, enough to completely absorb C's debt of 70
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, {from: D})
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, {from: E})

    await priceFeed.setPrice(dec(50, 18))

    // Try to liquidate C again. Check it succeeds and closes C's trove
    const liqTx2 = await troveManager.batchLiquidateTroves([C,D])
    assert.isTrue(liqTx2.receipt.status)
    assert.isFalse((await troveManager.getTroveStatus(C)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(D)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(E)).eq(toBN('1')))
  })

  it('batchLiquidateTroves(): closes every trove with ICR < MCR in the given array', async () => {
    // --- SETUP ---
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1ETH:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Confirm troves A-C are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mv._MCR))

    // Confirm D-E are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR >= 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    liquidationArray = [alice, bob, carol, dennis, erin]
    await troveManager.batchLiquidateTroves(liquidationArray);

    // Check all troves A-C are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')
  })

  it('batchLiquidateTroves(): does not liquidate troves that are not in the given array', async () => {
    // --- SETUP ---
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: toBN(dec(500, 18)), extraParams: { from: dennis } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: toBN(dec(500, 18)), extraParams: { from: erin } })

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1ETH:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Confirm troves A-E are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).lt(mv._MCR))

    liquidationArray = [alice, bob]  // C-E not included
    await troveManager.batchLiquidateTroves(liquidationArray);

    // Check all troves A-B are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')

    // Check all troves C-E are still active
    assert.equal((await troveManager.Troves(carol))[3].toString(), '1')
    assert.equal((await troveManager.Troves(dennis))[3].toString(), '1')
    assert.equal((await troveManager.Troves(erin))[3].toString(), '1')
  })

  it('batchLiquidateTroves(): does not close troves with ICR >= MCR in the given array', async () => {
    // --- SETUP ---
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(120, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1ETH:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Confirm troves A-C are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mv._MCR))

    // Confirm D-E are ICR >= 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR > 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    liquidationArray = [alice, bob, carol, dennis, erin]
    await troveManager.batchLiquidateTroves(liquidationArray);

    // Check all troves D-E and whale remain active
    assert.equal((await troveManager.Troves(dennis))[3].toString(), '1')
    assert.equal((await troveManager.Troves(erin))[3].toString(), '1')
    assert.isTrue((await troveManager.getTroveStatus(whale)).eq(toBN('1')))
  })

  it('batchLiquidateTroves(): reverts if array is empty', async () => {
    // --- SETUP ---
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(120, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1ETH:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    liquidationArray = []
    try {
      const tx = await troveManager.batchLiquidateTroves(liquidationArray);
      assert.isFalse(tx.receipt.status)
    } catch (error) {
      assert.include(error.message, "TroveManager: Calldata address array must not be empty")
    }
  })

  it("batchLiquidateTroves(): skips if trove is non-existent", async () => {
    // --- SETUP ---
    const spDeposit = toBN(dec(500000, 18))
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })

    const { totalDebt: A_debt } = await openTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: alice } })
    const { totalDebt: B_debt } = await openTrove({ ICR: toBN(dec(120, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    assert.equal(await troveManager.getTroveStatus(carol), 0) // check trove non-existent

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1ETH:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Confirm troves A-B are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))

    // Confirm D-E are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR >= 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    // Liquidate - trove C in between the ones to be liquidated!
    const liquidationArray = [alice, carol, bob, dennis, erin]
    await troveManager.batchLiquidateTroves(liquidationArray);

    // Check all troves A-B are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')

    // Confirm trove C non-existent
    assert.equal((await troveManager.Troves(carol))[3].toString(), '0')

    // Check Stability pool has only been reduced by A-B
    th.assertIsApproximatelyEqual((await stabilityPool.getTotalDebtDeposits()).toString(), spDeposit.sub(A_debt).sub(B_debt))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));
  })

  it("batchLiquidateTroves(): skips if a trove has been closed", async () => {
    // --- SETUP ---
    const spDeposit = toBN(dec(500000, 18))
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })

    const { totalDebt: A_debt } = await openTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: alice } })
    const { totalDebt: B_debt } = await openTrove({ ICR: toBN(dec(120, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    assert.isTrue((await troveManager.getTroveStatus(carol)).eq(toBN('1')))

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    // Whale transfers to Carol so she can close her trove
    await debtToken.transfer(carol, dec(100, 18), { from: whale })

    // --- TEST ---

    // Price drops to 1ETH:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    // Carol liquidated, and her trove is closed
    const txCarolClose = await borrowerOperations.closeTrove({ from: carol })
    assert.isTrue(txCarolClose.receipt.status)

    assert.equal(await troveManager.getTroveStatus(carol), 2)  // check trove closed

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));

    // Confirm troves A-B are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))

    // Confirm D-E are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR >= 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    // Liquidate - trove C in between the ones to be liquidated!
    const liquidationArray = [alice, carol, bob, dennis, erin]
    await troveManager.batchLiquidateTroves(liquidationArray);

    // Check all troves A-B are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    // Trove C still closed by user
    assert.equal((await troveManager.Troves(carol))[3].toString(), '2')

    // Check Stability pool has only been reduced by A-B
    th.assertIsApproximatelyEqual((await stabilityPool.getTotalDebtDeposits()).toString(), spDeposit.sub(A_debt).sub(B_debt))

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts));
  })

  it("batchLiquidateTroves: when SP > 0, triggers SATO reward event - increases the sum G", async () => {
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(167, 16)), extraParams: { from: C } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_1 } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_2 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })
    assert.equal(await stabilityPool.getTotalDebtDeposits(), dec(100, 18))

    const G_Before = await stabilityPool.epochToScaleToG(0, 0)

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // Price drops to 1ETH:100LUSD, reducing defaulters to below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate troves
    await troveManager.batchLiquidateTroves([defaulter_1, defaulter_2])
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))

    const G_After = await stabilityPool.epochToScaleToG(0, 0)

    // Expect G has increased from the SATO reward event triggered
    assert.isTrue(G_After.gt(G_Before))
  })

  it("batchLiquidateTroves(): when SP is empty, doesn't update G", async () => {
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(167, 16)), extraParams: { from: C } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_1 } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_2 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // B withdraws
    let _spWithdrawAmt = dec(100, 18);
    await stabilityPool.requestWithdrawFromSP(_spWithdrawAmt, { from: B })
	await th.fastForwardTime(timeValues.SECONDS_IN_TWO_HOURS + 123, web3.currentProvider)
    await stabilityPool.withdrawFromSP(_spWithdrawAmt, { from: B })

    // Check SP is empty
    assert.equal((await stabilityPool.getTotalDebtDeposits()), '0')

    // Check G is non-zero
    const G_Before = await stabilityPool.epochToScaleToG(0, 0)
    assert.isTrue(G_Before.gt(toBN('0')))

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // Price drops to 1ETH:100LUSD, reducing defaulters to below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // liquidate troves
    await troveManager.batchLiquidateTroves([defaulter_1, defaulter_2])
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))
    assert.isFalse((await troveManager.getTroveStatus(defaulter_2)).eq(toBN('1')))

    const G_After = await stabilityPool.epochToScaleToG(0, 0)

    // Expect G has not changed
    assert.isTrue(G_After.eq(G_Before))
  })

  // --- redemptions ---

  it('redeemCollateral(): cancels the provided LUSD with debt from Troves with the lowest ICRs and sends an equivalent amount of Ether', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_ETHBalance_Before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_Before = await debtToken.balanceOf(dennis)

    const price = await priceFeed.getPrice()
    let _p = dec(200, 18)
    assert.equal(price, _p)

    // --- TEST ---
    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    await debtToken.approve(troveManager.address, redemptionAmount, {from : dennis});
    const redemptionTx = await troveManager.redeemCollateral(
      redemptionAmount, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const ETHFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const alice_Trove_After = await troveManager.Troves(alice)
    const aEntireDebtAndColl = await troveManager.getEntireDebtAndColl(alice)
    const bob_Trove_After = await troveManager.Troves(bob)
    const bEntireDebtAndColl = await troveManager.getEntireDebtAndColl(bob)
    const carol_Trove_After = await troveManager.Troves(carol)
    const cEntireDebtAndColl = await troveManager.getEntireDebtAndColl(carol)

    const alice_debt_After = alice_Trove_After[0].toString()
    const bob_debt_After = bob_Trove_After[0].toString()
    const carol_debt_After = carol_Trove_After[0].toString()
    th.assertIsApproximatelyEqual(alice_debt_After, aEntireDebtAndColl[0].add(aEntireDebtAndColl[4]))
    th.assertIsApproximatelyEqual(bob_debt_After, bEntireDebtAndColl[0].add(bEntireDebtAndColl[4]))
    th.assertIsApproximatelyEqual(carol_debt_After, cEntireDebtAndColl[0].add(cEntireDebtAndColl[4]))

    const dennis_ETHBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedETH = dennis_ETHBalance_After.sub(dennis_ETHBalance_Before)

    const expectedTotalETHDrawn = redemptionAmount.mul(mv._1e18BN).div(toBN(_p)) // convert redemptionAmount LUSD to ETH, at ETH:USD price 200
    const expectedReceivedETH = expectedTotalETHDrawn.sub(toBN(ETHFee));//.sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used for troveManager.redeemCollateral from expected received ETH
    
    // console.log("*********************************************************************************")
    // console.log("ETHFee: " + ETHFee)
    // console.log("dennis_ETHBalance_Before: " + dennis_ETHBalance_Before)
    // console.log("GAS_USED: " + th.gasUsed(redemptionTx))
    // console.log("dennis_ETHBalance_After: " + dennis_ETHBalance_After)
    // console.log("expectedTotalETHDrawn: " + expectedTotalETHDrawn)
    // console.log("recived  : " + receivedETH)
    // console.log("expected : " + expectedReceivedETH)
    // console.log("wanted :   " + expectedReceivedETH.sub(toBN(GAS_PRICE)))
    // console.log("*********************************************************************************")
    th.assertIsApproximatelyEqual(expectedReceivedETH, receivedETH)

    const dennis_LUSDBalance_After = (await debtToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_Before.sub(redemptionAmount))
  })

  it('redeemCollateral(): with invalid first hint, zero address', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_ETHBalance_Before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_Before = await debtToken.balanceOf(dennis)

    const price = await priceFeed.getPrice()
    let _p = dec(200, 18)
    assert.equal(price, _p)

    // --- TEST ---
    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    await debtToken.approve(troveManager.address, redemptionAmount, {from : dennis});
    const redemptionTx = await troveManager.redeemCollateral(
      redemptionAmount, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE 
      }
    )

    const ETHFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const alice_Trove_After = await troveManager.Troves(alice)
    const aEntireDebtAndColl = await troveManager.getEntireDebtAndColl(alice) 
    const bob_Trove_After = await troveManager.Troves(bob)
    const bEntireDebtAndColl = await troveManager.getEntireDebtAndColl(bob) 
    const carol_Trove_After = await troveManager.Troves(carol)
    const cEntireDebtAndColl = await troveManager.getEntireDebtAndColl(carol) 

    const alice_debt_After = alice_Trove_After[0].toString()
    const bob_debt_After = bob_Trove_After[0].toString()
    const carol_debt_After = carol_Trove_After[0].toString()
    th.assertIsApproximatelyEqual(alice_debt_After, aEntireDebtAndColl[0].add(aEntireDebtAndColl[4]))
    th.assertIsApproximatelyEqual(bob_debt_After, bEntireDebtAndColl[0].add(bEntireDebtAndColl[4]))
    th.assertIsApproximatelyEqual(carol_debt_After, cEntireDebtAndColl[0].add(cEntireDebtAndColl[4]))

    const dennis_ETHBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedETH = dennis_ETHBalance_After.sub(dennis_ETHBalance_Before)

    const expectedTotalETHDrawn = redemptionAmount.mul(mv._1e18BN).div(toBN(_p)) // convert redemptionAmount LUSD to ETH, at ETH:USD price 200
    const expectedReceivedETH = expectedTotalETHDrawn.sub(toBN(ETHFee));//.sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used for troveManager.redeemCollateral from expected received ETH

    th.assertIsApproximatelyEqual(expectedReceivedETH, receivedETH)

    const dennis_LUSDBalance_After = (await debtToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_Before.sub(redemptionAmount))
  })

  it('redeemCollateral(): with invalid first hint, non-existent trove', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_ETHBalance_Before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_Before = await debtToken.balanceOf(dennis)

    const price = await priceFeed.getPrice()
    let _p = dec(200, 18)
    assert.equal(price, _p)

    // --- TEST ---

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    await debtToken.approve(troveManager.address, redemptionAmount, {from : dennis});
    const redemptionTx = await troveManager.redeemCollateral(
      redemptionAmount, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const ETHFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const alice_Trove_After = await troveManager.Troves(alice)
    const aEntireDebtAndColl = await troveManager.getEntireDebtAndColl(alice) 
    const bob_Trove_After = await troveManager.Troves(bob)
    const bEntireDebtAndColl = await troveManager.getEntireDebtAndColl(bob) 
    const carol_Trove_After = await troveManager.Troves(carol)
    const cEntireDebtAndColl = await troveManager.getEntireDebtAndColl(carol) 

    const alice_debt_After = alice_Trove_After[0].toString()
    const bob_debt_After = bob_Trove_After[0].toString()
    const carol_debt_After = carol_Trove_After[0].toString()

    /* check that Dennis' redeemed 20 LUSD has been cancelled with debt from Bobs's Trove (8) and Carol's Trove (10).
    The remaining lot (2) is sent to Alice's Trove, who had the best ICR.
    It leaves her with (3) LUSD debt + 50 for gas compensation. */
    th.assertIsApproximatelyEqual(alice_debt_After, aEntireDebtAndColl[0].add(aEntireDebtAndColl[4]))
    th.assertIsApproximatelyEqual(bob_debt_After, bEntireDebtAndColl[0].add(bEntireDebtAndColl[4]))
    th.assertIsApproximatelyEqual(carol_debt_After, cEntireDebtAndColl[0].add(cEntireDebtAndColl[4]))

    const dennis_ETHBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedETH = dennis_ETHBalance_After.sub(dennis_ETHBalance_Before)

    const expectedTotalETHDrawn = redemptionAmount.mul(mv._1e18BN).div(toBN(_p)) // convert redemptionAmount LUSD to ETH, at ETH:USD price 200
    const expectedReceivedETH = expectedTotalETHDrawn.sub(toBN(ETHFee));//.sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used for troveManager.redeemCollateral from expected received ETH

    th.assertIsApproximatelyEqual(expectedReceivedETH, receivedETH)

    const dennis_LUSDBalance_After = (await debtToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_Before.sub(redemptionAmount))
  })

  it('redeemCollateral(): with invalid first hint, trove below MCR', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_ETHBalance_Before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_Before = await debtToken.balanceOf(dennis)

    const price = await priceFeed.getPrice()
    let _p = dec(200, 18);
    assert.equal(price, _p)

    // Increase price to start Erin, and decrease it again so its ICR is under MCR
    await priceFeed.setPrice(price.mul(toBN(2)))
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: erin } })
    await priceFeed.setPrice(price)


    // --- TEST ---

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    await debtToken.approve(troveManager.address, redemptionAmount, {from : dennis});
    const redemptionTx = await troveManager.redeemCollateral(
      redemptionAmount, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const ETHFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const alice_Trove_After = await troveManager.Troves(alice)
    const aEntireDebtAndColl = await troveManager.getEntireDebtAndColl(alice) 
    const bob_Trove_After = await troveManager.Troves(bob)
    const bEntireDebtAndColl = await troveManager.getEntireDebtAndColl(bob) 
    const carol_Trove_After = await troveManager.Troves(carol)
    const cEntireDebtAndColl = await troveManager.getEntireDebtAndColl(carol) 

    const alice_debt_After = alice_Trove_After[0].toString()
    const bob_debt_After = bob_Trove_After[0].toString()
    const carol_debt_After = carol_Trove_After[0].toString()

    /* check that Dennis' redeemed 20 LUSD has been cancelled with debt from Bobs's Trove (8) and Carol's Trove (10).
    The remaining lot (2) is sent to Alice's Trove, who had the best ICR.
    It leaves her with (3) LUSD debt + 50 for gas compensation. */
    th.assertIsApproximatelyEqual(alice_debt_After, aEntireDebtAndColl[0].add(aEntireDebtAndColl[4]))
    th.assertIsApproximatelyEqual(bob_debt_After, bEntireDebtAndColl[0].add(bEntireDebtAndColl[4]))
    th.assertIsApproximatelyEqual(carol_debt_After, cEntireDebtAndColl[0].add(cEntireDebtAndColl[4]))

    const dennis_ETHBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedETH = dennis_ETHBalance_After.sub(dennis_ETHBalance_Before)

    const expectedTotalETHDrawn = redemptionAmount.mul(mv._1e18BN).div(toBN(_p)) // convert redemptionAmount LUSD to ETH, at ETH:USD price 200
    const expectedReceivedETH = expectedTotalETHDrawn.sub(toBN(ETHFee));//.sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used for troveManager.redeemCollateral from expected received ETH

    th.assertIsApproximatelyEqual(expectedReceivedETH, receivedETH)

    const dennis_LUSDBalance_After = (await debtToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_Before.sub(redemptionAmount))
  })

  it('redeemCollateral(): ends the redemption sequence when the token redemption request has been filled', async () => {
    // --- SETUP --- 
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol, Dennis, Erin open troves
    const { netDebt: A_debt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: alice } })
    const { netDebt: B_debt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
    const { netDebt: C_debt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })
    const redemptionAmount = A_debt.add(B_debt).add(C_debt)
    const { totalDebt: D_totalDebt, collateral: D_coll } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: dennis } })
    const { totalDebt: E_totalDebt, collateral: E_coll } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: erin } })

    // --- TEST --- 

    // open trove from redeemer.  Redeemer has highest ICR (100ETH, 100 LUSD), 20000%
    const { debtAmount: F_lusdAmount } = await openTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount.mul(toBN(2)), extraParams: { from: flyn } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Flyn redeems collateral
    await debtToken.approve(troveManager.address, redemptionAmount, {from : flyn});
    await troveManager.redeemCollateral(redemptionAmount, th._100pct, { from: flyn })

    // Check Flyn's redemption has reduced his balance from 100 to (100-60) = 40 LUSD
    const flynBalance = await debtToken.balanceOf(flyn)
    th.assertIsApproximatelyEqual(flynBalance, F_lusdAmount.sub(redemptionAmount))

    // Check debt of Alice, Bob, Carol
    const alice_Debt = await troveManager.getTroveDebt(alice)
    const aEntireDebtAndColl = await troveManager.getEntireDebtAndColl(alice) 
    const bob_Debt = await troveManager.getTroveDebt(bob)
    const bEntireDebtAndColl = await troveManager.getEntireDebtAndColl(bob) 
    const carol_Debt = await troveManager.getTroveDebt(carol)
    const cEntireDebtAndColl = await troveManager.getEntireDebtAndColl(carol) 

    console.log('cachedDebt=' + alice_Debt + ',debt=' + aEntireDebtAndColl[0] + ',rpendingDebt=' + aEntireDebtAndColl[4] + ',free=' + aEntireDebtAndColl[6]);
    assert.equal(alice_Debt.toString(), aEntireDebtAndColl[0].add(aEntireDebtAndColl[4]).toString())
    assert.equal(bob_Debt.toString(), bEntireDebtAndColl[0].add(bEntireDebtAndColl[4]).toString())
    assert.equal(carol_Debt.toString(), cEntireDebtAndColl[0].add(cEntireDebtAndColl[4]).toString())

    // check Alice, Bob and Carol troves are not closed by redemption
    const alice_Status = await troveManager.getTroveStatus(alice)
    const bob_Status = await troveManager.getTroveStatus(bob)
    const carol_Status = await troveManager.getTroveStatus(carol)
    assert.equal(alice_Status, 1)
    assert.equal(bob_Status, 1)
    assert.equal(carol_Status, 1)

    // check debt and coll of Dennis, Erin has not been impacted by redemption
    const dennis_Debt = await troveManager.getTroveDebt(dennis)
    const erin_Debt = await troveManager.getTroveDebt(erin)

    th.assertIsApproximatelyEqual(dennis_Debt, D_totalDebt)
    th.assertIsApproximatelyEqual(erin_Debt, E_totalDebt)

    const dennis_Coll = await troveManager.getTroveColl(dennis)
    const erin_Coll = await troveManager.getTroveColl(erin)

    assert.equal(dennis_Coll.toString(), D_coll.toString())
    assert.equal(erin_Coll.toString(), E_coll.toString())
  })

  it('redeemCollateral(): ends the redemption sequence when max iterations have been reached', async () => {
    // --- SETUP --- 
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol open troves with equal collateral ratio
    const { netDebt: A_debt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: alice } })
    const { netDebt: B_debt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
    const { netDebt: C_debt, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })
    const redemptionAmount = A_debt.add(B_debt)
    const attemptedRedemptionAmount = redemptionAmount.add(C_debt)

    // --- TEST --- 

    // open trove from redeemer.  Redeemer has highest ICR (100ETH, 100 LUSD), 20000%
    const { lusdAmount: F_lusdAmount } = await openTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount.mul(toBN(2)), extraParams: { from: flyn } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Flyn redeems collateral with only two iterations
    const flynBalanceBefore = await debtToken.balanceOf(flyn)
    await debtToken.approve(troveManager.address, attemptedRedemptionAmount, {from : flyn});
    await troveManager.redeemCollateral(attemptedRedemptionAmount, th._100pct, { from: flyn })

    // Check Flyn's redemption has reduced his balance from 100 to (100-40) = 60 LUSD
    const flynBalance = (await debtToken.balanceOf(flyn)).toString()
    th.assertIsApproximatelyEqual(flynBalance, flynBalanceBefore.sub(attemptedRedemptionAmount))

    // Check debt of Alice, Bob, Carol
    const alice_Debt = await troveManager.getTroveDebt(alice)
    const aEntireDebtAndColl = await troveManager.getEntireDebtAndColl(alice) 
    const bob_Debt = await troveManager.getTroveDebt(bob)
    const bEntireDebtAndColl = await troveManager.getEntireDebtAndColl(bob) 
    const carol_Debt = await troveManager.getTroveDebt(carol)
    const cEntireDebtAndColl = await troveManager.getEntireDebtAndColl(carol) 

    th.assertIsApproximatelyEqual(alice_Debt, aEntireDebtAndColl[0].add(aEntireDebtAndColl[4]), 10000)
    th.assertIsApproximatelyEqual(bob_Debt, bEntireDebtAndColl[0].add(bEntireDebtAndColl[4]), 10000)
    th.assertIsApproximatelyEqual(carol_Debt, cEntireDebtAndColl[0].add(cEntireDebtAndColl[4]), 10000)

    // check Alice Bob and Carol still have active Trove
    const alice_Status = await troveManager.getTroveStatus(alice)
    const bob_Status = await troveManager.getTroveStatus(bob)
    const carol_Status = await troveManager.getTroveStatus(carol)
    assert.equal(alice_Status, 1)
    assert.equal(bob_Status, 1)
    assert.equal(carol_Status, 1)
  })

  it("redeemCollateral(): performs partial redemption if resultant debt is > minimum net debt", async () => {
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : A});
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : B});
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : C});
    await collateralToken.deposit({from : A, value: dec(1000, 'ether') });
    await collateralToken.deposit({from : B, value: dec(1000, 'ether') });
    await collateralToken.deposit({from : C, value: dec(1000, 'ether') });
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(10000, 18)), dec(1000, 'ether'), { from: A, value: 0 })
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(20000, 18)), dec(1000, 'ether'), { from: B, value: 0 })
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(30000, 18)), dec(1000, 'ether'), { from: C, value: 0 })

    // A and C send all their tokens to B
    await debtToken.transfer(B, await debtToken.balanceOf(A), {from: A})
    await debtToken.transfer(B, await debtToken.balanceOf(C), {from: C})
    
    await troveManager.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption is 55000 US
    const LUSDRedemption = dec(55000, 18)
    const tx1 = await th.redeemCollateralAndGetTxObject(B, contracts, LUSDRedemption, th._100pct)
    
    // Check B, C and A remains active
    assert.isTrue((await troveManager.getTroveStatus(A)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(B)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(C)).eq(toBN('1')))

    // A's remaining debt = 29800 + 19800 + 9800 + 200 - 55000 = 4600
    const aEntireDebtAndColl = await troveManager.getEntireDebtAndColl(A)
    await assert.isTrue(aEntireDebtAndColl[0].eq(toBN('0'))) 
    await assert.isTrue(aEntireDebtAndColl[6].gt(toBN('0'))) 
  })
  
  it("redeemCollateral(): check ICR relation change between new and old Troves", async () => {
    await openTrove({ ICR: toBN(dec(135, 16)), extraLUSDAmount: dec(200, 18), extraParams: { from: whale } })
    await openTrove({ ICR: toBN(dec(1965, 16)), extraLUSDAmount: dec(200, 18), extraParams: { from: alice } })
	
    let _whaleDFee = (await troveManager.getTroveDebt(whale)).sub(await debtToken.balanceOf(whale));
    let _whaleS = await troveManager.getTroveStake(whale);

    // Skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    await th.redeemCollateralAndGetTxObject(whale, contracts, dec(1,18), GAS_PRICE, th._100pct)
    let _p = await priceFeed.getPrice();	

    let _whaleEntireDebtAndColl = await troveManager.getEntireDebtAndColl(whale);
    let _whaleC = _whaleEntireDebtAndColl[1]
    let _whaleD = _whaleEntireDebtAndColl[0].sub(_whaleDFee)
    console.log('_whaleD=' + _whaleD + ',_whaleC=' + _whaleC + ',_whaleDFee=' + _whaleDFee + ',_whaleS=' + _whaleS)
	
    // first redemption
    const btUSDRedemption1 = dec(50, 18)
    let _collRdp1 = toBN(btUSDRedemption1).mul(mv._1e18BN).div(_p)
    let _totalCollSnapshot0 = await troveManager.totalCollateralSnapshot();
    let _totalStakeSnapshot0 = await troveManager.totalStakesSnapshot();
    let _totalStake0 = await troveManager.totalStakes();
    await th.redeemCollateralAndGetTxObject(whale, contracts, btUSDRedemption1, GAS_PRICE, th._100pct)
    _whaleEntireDebtAndColl = await troveManager.getEntireDebtAndColl(whale);
    let _whaleCollChange0 = _whaleC.sub(_whaleEntireDebtAndColl[1])
    console.log('_whaleCollChange0=' + _whaleCollChange0);
    let _totalStake1 = await troveManager.totalStakes();
    let _totalCollSnapshot = await troveManager.totalCollateralSnapshot();
    let _totalStakeSnapshot = await troveManager.totalStakesSnapshot();
    let _systemColl = await troveManager.getEntireSystemColl();
    let _collRdp1PerStake = _collRdp1.mul(mv._1e18BN).div(_totalStake0)
    console.log('_totalStake1=' + _totalStake1 + ',_totalCollSnapshot=' + _totalCollSnapshot + ',_collRdp1=' + _collRdp1 + ',_systemColl=' + _systemColl + ',_collRdp1PerStake=' + _collRdp1PerStake);
    console.log('_totalStakeSnapshot0=' + _totalStakeSnapshot0 + ',_totalStakeSnapshot=' + _totalStakeSnapshot + ',_totalCollSnapshot0=' + _totalCollSnapshot0);
    assert.isTrue(_systemColl.eq(_totalCollSnapshot))
    assert.isTrue(_totalStakeSnapshot.eq(_totalStakeSnapshot0))
    assert.isTrue(_totalStakeSnapshot0.gt(_totalCollSnapshot))
    assert.isTrue(_totalStake0.eq(_totalStake1))
	
    // alice close trove	
    let _totalSystemCollBefore = await troveManager.getEntireSystemColl()
    let _totalStakesBefore = await troveManager.totalStakes()
    let _stakeAlice = await troveManager.getTroveStake(alice)
    await borrowerOperations.closeTrove({from: alice});
    let _totalStakesAfter = await troveManager.totalStakes()
    let _totalSystemCollAfter = await troveManager.getEntireSystemColl()
    let _totalStakesChange = _totalStakesBefore.sub(_totalStakesAfter)
    let _totalStakesChangePercentage = _totalStakesChange.mul(mv._1e18BN).div(_totalStakesBefore)
    let _totalSystemCollChange = _totalSystemCollBefore.sub(_totalSystemCollAfter)
    let _totalSystemCollChangePercentage = _totalSystemCollChange.mul(mv._1e18BN).div(_totalSystemCollBefore)
    assert.isTrue(_totalStakesAfter.eq(_totalStakesBefore.sub(_stakeAlice)));
    console.log('_totalStakesChangePercentage=' + _totalStakesChangePercentage + ',_totalSystemCollChangePercentage=' + _totalSystemCollChangePercentage);
    assert.isTrue(_totalStakesChangePercentage.lt(_totalSystemCollChangePercentage));
	
    // bob open a trove identical to whale
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : bob});
    await collateralToken.deposit({from : bob, value: _whaleC });
    await borrowerOperations.openTrove(th._100pct, _whaleD, _whaleC, { from: bob, value: 0 })
	
    let _systemColl2 = await troveManager.getEntireSystemColl();
    console.log('_systemColl2=' + _systemColl2 + ',x(_systemColl2/_systemColl)=' + (_systemColl2.mul(mv._1e18BN).div(_systemColl)));
    let _totalStake2 = await troveManager.totalStakes();
    console.log('_totalStake2=' + _totalStake2 + ',x(_totalStake2/_totalStake1)=' + (_totalStake2.mul(mv._1e18BN).div(_totalStake1)));
    assert.isTrue(_totalStake1.gt(_totalStake2))
	
    let _bobICR = await troveManager.getCurrentICR(bob, _p);
    let _whaleICR = await troveManager.getCurrentICR(whale, _p);
    console.log('_whaleICR=' + _whaleICR + ',_bobICR=' + _bobICR);
    assert.isTrue(_whaleICR.gt(_bobICR))
    let _bobC = await troveManager.getTroveColl(bob);
    let _bobD = await troveManager.getTroveDebt(bob);
    let _bobS = await troveManager.getTroveStake(bob);
    assert.isTrue(_bobS.gt(_whaleS)) // bob's stake is larger than whale though they have same collateral
    console.log('_bobC=' + _bobC + ',_bobD=' + _bobD + ',_bobS=' + _bobS + ',k(bobS/whaleS)=' + (_bobS.mul(mv._1e18BN).div(_whaleS)));
    th.assertIsApproximatelyEqual(_bobS, _whaleS.mul(_totalCollSnapshot0).div(_totalCollSnapshot))
    _whaleEntireDebtAndColl = await troveManager.getEntireDebtAndColl(whale);
    console.log('_whaleC=' + _whaleEntireDebtAndColl[1] + ',_whaleD=' + _whaleEntireDebtAndColl[0]);
	
    // try second redemption to flip ICR
    const _collRdp2 = _totalCollSnapshot.mul(_totalStake2).div(_totalStake1)
    let btUSDRedemption2 = _collRdp2.mul(_p).div(mv._1e18BN)
    let _systemDebt = (await troveManager.getEntireSystemDebt()).sub(await activePool.getRedeemedDebt())
    console.log('btUSDRedemption2=' + btUSDRedemption2 + ',_collRdp2=' + _collRdp2 + ',_systemDebt=' + _systemDebt);
    assert.isTrue(btUSDRedemption2.gte(_systemDebt))

    // ICR relation between whale and bob's trove should keep the same
    const btUSDRedemption3 = dec(150, 18)
    let _collRdp3 = toBN(btUSDRedemption3).mul(mv._1e18BN).div(_p)
    await debtToken.transfer(whale, await debtToken.balanceOf(bob), {from: bob})
    await th.redeemCollateralAndGetTxObject(whale, contracts, btUSDRedemption3, GAS_PRICE, th._100pct)
    _bobICR = await troveManager.getCurrentICR(bob, _p);
    _whaleICR = await troveManager.getCurrentICR(whale, _p);
    console.log('_whaleICR=' + _whaleICR + ',_bobICR=' + _bobICR);
    assert.isTrue(_whaleICR.gt(_bobICR))
  })
  
  it("redeemCollateral(): check ICR relation change between existing Troves", async () => {
    await openTrove({ ICR: toBN(dec(165, 16)), extraLUSDAmount: dec(200, 18), extraParams: { from: whale } })
	
    let _whaleC = await troveManager.getTroveColl(whale);
    let _whaleD = await troveManager.getTroveDebt(whale);
    let _whaleDFee = _whaleD.sub(await debtToken.balanceOf(whale));
    let _p = await priceFeed.getPrice();	

    // Skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)	
	
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : bob});
    await collateralToken.deposit({from : bob, value: _whaleC });
    await borrowerOperations.openTrove(th._100pct, _whaleD.add(toBN(dec(10, 18))), _whaleC, { from: bob, value: 0 })
	
    let _bobICR = await troveManager.getCurrentICR(bob, _p);
    let _whaleICR = await troveManager.getCurrentICR(whale, _p);
    console.log('_whaleICR=' + _whaleICR + ',_bobICR=' + _bobICR);
    assert.isTrue(_whaleICR.gt(_bobICR))
	
    // do redemption
    const btUSDRedemption1 = dec(50, 18)
    await debtToken.transfer(whale, await debtToken.balanceOf(bob), {from: bob})
    await th.redeemCollateralAndGetTxObject(whale, contracts, btUSDRedemption1, GAS_PRICE, th._100pct)
	
    // ICR relation between whale and bob's trove should keep the same
    _bobICR = await troveManager.getCurrentICR(bob, _p);
    _whaleICR = await troveManager.getCurrentICR(whale, _p);
    console.log('_whaleICR=' + _whaleICR + ',_bobICR=' + _bobICR);
    assert.isTrue(_whaleICR.gt(_bobICR))
  })

  it("redeemCollateral(): doesn't perform partial redemption if resultant debt would be < minimum net debt", async () => {
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : A});
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : B});
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : C});
    await collateralToken.deposit({from : A, value: dec(1000, 'ether') });
    await collateralToken.deposit({from : B, value: dec(1000, 'ether') });
    await collateralToken.deposit({from : C, value: dec(1000, 'ether') });
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(6000, 18)), dec(1000, 'ether'), { from: A, value: 0 })
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(18500, 18)), dec(1000, 'ether'), { from: B, value: 0 })
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(31500, 18)), dec(1000, 'ether'), { from: C, value: 0 })

    // A and C send all their tokens to B
    await debtToken.transfer(B, await debtToken.balanceOf(A), {from: A})
    await debtToken.transfer(B, await debtToken.balanceOf(C), {from: C})

    await troveManager.setBaseRate(0) 

    // Skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption is 55000 LUSD
    const LUSDRedemption = dec(55000, 18)
    let _p = await priceFeed.getPrice()
    let _tcrBefore = await troveManager.getTCR(_p)
    let _aIcrBefore = await troveManager.getCurrentICR(A, _p)
    let _bIcrBefore = await troveManager.getCurrentICR(B, _p)
    let _cIcrBefore = await troveManager.getCurrentICR(C, _p)
    let _totalDebtBefore = await activePool.getLUSDDebt()
    let _totalSupplyBefore = await debtToken.totalSupply()
    const tx1 = await th.redeemCollateralAndGetTxObject(B, contracts, LUSDRedemption, GAS_PRICE, th._100pct)
    let _totalDebtAfter = await activePool.getLUSDDebt()
    let _totalSupplyAfter = await debtToken.totalSupply()
    let _debtBalanceInAP = await debtToken.balanceOf(activePool.address)
    assert.isTrue(_totalDebtBefore.eq(_totalDebtAfter))
    assert.isTrue(_totalSupplyBefore.eq(_totalSupplyAfter))
    let _redeemedDebtTracker = await activePool.getRedeemedDebt() 
    console.log('_totalDebtBefore=' + _totalDebtBefore + ',_totalDebtAfter=' + _totalDebtAfter + ',_redeemedDebtTracker=' + _redeemedDebtTracker)
    assert.isTrue(_redeemedDebtTracker.eq(toBN(LUSDRedemption)));
    assert.isTrue(_debtBalanceInAP.eq(toBN(LUSDRedemption)));
	
    // check sum of Trove's debt and system debt accounting
    let _aTroveDebt = await troveManager.getTroveDebt(A);
    let _bTroveDebt = await troveManager.getTroveDebt(B);
    let _cTroveDebt = await troveManager.getTroveDebt(C);
    assert.isTrue(_totalDebtAfter.eq(_aTroveDebt.add(_bTroveDebt).add(_cTroveDebt)))
    assert.isTrue(_totalDebtAfter.eq(_totalSupplyAfter));
	
    // ensure redemption will increase TCR and individual ICR
    let _tcrAfter = await troveManager.getTCR(_p)
    let _aIcrAfter = await troveManager.getCurrentICR(A, _p)
    console.log('_aIcrAfter=' + _aIcrAfter)
    let _bIcrAfter = await troveManager.getCurrentICR(B, _p)
    let _cIcrAfter = await troveManager.getCurrentICR(C, _p)
    assert.isTrue(_tcrAfter.gt(_tcrBefore));
    assert.isTrue(_aIcrAfter.gt(_aIcrBefore));
    assert.isTrue(_aIcrAfter.eq(toBN('115792089237316195423570985008687907853269984665640564039457584007913129639935')))// max due to zero debt
    assert.isTrue(_bIcrAfter.gt(_bIcrBefore));
    assert.isTrue(_cIcrAfter.gt(_cIcrBefore));	
    
    // Check B, C and A remains active
    assert.isTrue((await troveManager.getTroveStatus(A)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(B)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(C)).eq(toBN('1')))

    // A's debt would be emptied due to redemption share and A got some "free" debt 
    let aEntireDebtAndColl = await troveManager.getEntireDebtAndColl(A)
    assert.isTrue(aEntireDebtAndColl[0].eq(toBN('0')))
    let _aTroveColl = aEntireDebtAndColl[1]
    let _freeDebt = aEntireDebtAndColl[6];
    assert.isTrue(_freeDebt.gt(toBN('0')))
    let _aPendingRedemptionDebt = aEntireDebtAndColl[4];
	
    // A could "scavenge" its own Trove
    let _aDebtBefore = await debtToken.balanceOf(A)
    let _aCollBefore = await collateralToken.balanceOf(A)
    _totalDebtBefore = await activePool.getLUSDDebt()
    _totalSupplyBefore = await debtToken.totalSupply()
    let _stakeA = await troveManager.getTroveStake(A)
    let _totalStakesBefore = await troveManager.totalStakes()
    await troveManager.scavengeTrove(A, {from: A}) 
    let _totalStakesAfter = await troveManager.totalStakes()
    _totalDebtAfter = await activePool.getLUSDDebt()
    _totalSupplyAfter = await debtToken.totalSupply()
    assert.isTrue(_totalStakesAfter.eq(_totalStakesBefore.sub(_stakeA)))
    assert.isTrue((await troveManager.getTroveStatus(A)).eq(toBN('4')))
    let _aDebtAfter = await debtToken.balanceOf(A)
    let _aCollAfter = await collateralToken.balanceOf(A)
    assert.isTrue(_aDebtAfter.sub(_aDebtBefore).eq(_freeDebt));
    assert.isTrue(_aCollAfter.sub(_aCollBefore).eq(_aTroveColl));
    let _burnedDebt = _aPendingRedemptionDebt.sub(_freeDebt);
    assert.isTrue(_totalDebtBefore.sub(_totalDebtAfter).eq(_burnedDebt))
    assert.isTrue(_totalSupplyBefore.sub(_totalSupplyAfter).eq(_burnedDebt))
    let _redeemedDebtTrackerAfterA = await activePool.getRedeemedDebt() 
    assert.isTrue(_redeemedDebtTracker.sub(_redeemedDebtTrackerAfterA).eq(_aPendingRedemptionDebt))
	
    _bTroveDebt = await troveManager.getTroveDebt(B);
    _cTroveDebt = await troveManager.getTroveDebt(C);
    assert.isTrue(_totalDebtAfter.eq(_bTroveDebt.add(_cTroveDebt)))
    assert.isTrue(_totalDebtAfter.eq(_totalSupplyAfter));

    // B's debt would be below minimum debt requirement due to redemption share 
    let bEntireDebtAndColl = await troveManager.getEntireDebtAndColl(B)
    let _bTroveColl = bEntireDebtAndColl[1]
    let _bTroveDebtApplied = bEntireDebtAndColl[0]
    await assert.isTrue(_bTroveDebtApplied.lt(MIN_DEBT))
    await assert.isTrue(bEntireDebtAndColl[6].eq(toBN('0')))
    let _bBurnedDebt = bEntireDebtAndColl[4]
	
    // A could "scavenge" B's Trove and get some reward
    let _expectedCollReward = _bTroveDebtApplied.mul(mv._MCR).div(toBN(_p))
    _aDebtBefore = await debtToken.balanceOf(A)
    _aCollBefore = await collateralToken.balanceOf(A)
    console.log('_aDebtBal=' + _aDebtBefore + ',_bTroveDebtApplied=' + _bTroveDebtApplied)
    await debtToken.approve(troveManager.address, mv._1Be18BN, {from : A});
    _totalDebtBefore = await activePool.getLUSDDebt()
    _totalSupplyBefore = await debtToken.totalSupply()
    let _bCollsurplusBefore = await collSurplusPool.getCollateral(B)
    let _stakeB = await troveManager.getTroveStake(B)
    _totalStakesBefore = await troveManager.totalStakes()
    await troveManager.scavengeTrove(B, {from: A}) 
    _totalStakesAfter = await troveManager.totalStakes()
    assert.isTrue(_totalStakesAfter.eq(_totalStakesBefore.sub(_stakeB)))
    _totalDebtAfter = await activePool.getLUSDDebt()
    _totalSupplyAfter = await debtToken.totalSupply()
    let _bCollsurplusAfter = await collSurplusPool.getCollateral(B)
    assert.isTrue(_bCollsurplusAfter.sub(_bCollsurplusBefore).eq(_bTroveColl.sub(_expectedCollReward)));
    assert.isTrue((await troveManager.getTroveStatus(B)).eq(toBN('4')))
    _aDebtAfter = await debtToken.balanceOf(A)
    _aCollAfter = await collateralToken.balanceOf(A)	
    assert.isTrue(_aDebtBefore.sub(_aDebtAfter).eq(_bTroveDebtApplied));
    assert.isTrue(_aCollAfter.sub(_aCollBefore).eq(_expectedCollReward));	
    console.log('_totalDebtBefore=' + _totalDebtBefore + ',_totalDebtAfter=' + _totalDebtAfter)
    assert.isTrue(_totalDebtBefore.sub(_totalDebtAfter).eq(_bTroveDebtApplied.add(_bBurnedDebt)))
    assert.isTrue(_totalSupplyBefore.sub(_totalSupplyAfter).eq(_bTroveDebtApplied.add(_bBurnedDebt)))
    let _redeemedDebtTrackerAfterB = await activePool.getRedeemedDebt() 
    assert.isTrue(_redeemedDebtTrackerAfterA.sub(_redeemedDebtTrackerAfterB).eq(_bBurnedDebt))
	
    _cTroveDebt = await troveManager.getTroveDebt(C);
    assert.isTrue(_totalDebtAfter.eq(_cTroveDebt))
    assert.isTrue(_totalDebtAfter.eq(_totalSupplyAfter));
	
    // B could claim its collateral surplus now
    let _bCollBefore = await collateralToken.balanceOf(B)
    await borrowerOperations.claimCollateral({from: B});
    let _bCollAfter = await collateralToken.balanceOf(B)
    assert.isTrue(_bCollAfter.sub(_bCollBefore).eq(_bCollsurplusAfter))	
  })

  it("redeemCollateral(): doesn't perform scavenge if liquidatable", async () => {
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : A});
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : B});
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : C});
    await collateralToken.deposit({from : A, value: dec(1000, 'ether') });
    await collateralToken.deposit({from : B, value: dec(1000, 'ether') });
    await collateralToken.deposit({from : C, value: dec(1000, 'ether') });
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(6000, 18)), dec(1000, 'ether'), { from: A, value: 0 })
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(18500, 18)), dec(1000, 'ether'), { from: B, value: 0 })
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(31500, 18)), dec(1000, 'ether'), { from: C, value: 0 })

    // A and C send all their tokens to B
    await debtToken.transfer(B, await debtToken.balanceOf(A), {from: A})
    await debtToken.transfer(B, await debtToken.balanceOf(C), {from: C})

    await troveManager.setBaseRate(0) 

    // Skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption is 55000 LUSD
    const LUSDRedemption = dec(55000, 18)
    let _p = await priceFeed.getPrice()
    let _tcrBefore = await troveManager.getTCR(_p)
    let _aIcrBefore = await troveManager.getCurrentICR(A, _p)
    let _bIcrBefore = await troveManager.getCurrentICR(B, _p)
    let _cIcrBefore = await troveManager.getCurrentICR(C, _p)
    let _totalDebtBefore = await activePool.getLUSDDebt()
    let _totalSupplyBefore = await debtToken.totalSupply()
    const tx1 = await th.redeemCollateralAndGetTxObject(B, contracts, LUSDRedemption, GAS_PRICE, th._100pct)
    let _totalDebtAfter = await activePool.getLUSDDebt()
    let _totalSupplyAfter = await debtToken.totalSupply()
    let _debtBalanceInAP = await debtToken.balanceOf(activePool.address)
    assert.isTrue(_totalDebtBefore.eq(_totalDebtAfter))
    assert.isTrue(_totalSupplyBefore.eq(_totalSupplyAfter))
    let _redeemedDebtTracker = await activePool.getRedeemedDebt() 
    console.log('_totalDebtBefore=' + _totalDebtBefore + ',_totalDebtAfter=' + _totalDebtAfter + ',_redeemedDebtTracker=' + _redeemedDebtTracker)
    assert.isTrue(_redeemedDebtTracker.eq(toBN(LUSDRedemption)));
    assert.isTrue(_debtBalanceInAP.eq(toBN(LUSDRedemption)));
	
    // check sum of Trove's debt and system debt accounting
    let _aTroveDebt = await troveManager.getTroveDebt(A);
    let _bTroveDebt = await troveManager.getTroveDebt(B);
    let _cTroveDebt = await troveManager.getTroveDebt(C);
    assert.isTrue(_totalDebtAfter.eq(_aTroveDebt.add(_bTroveDebt).add(_cTroveDebt)))
    assert.isTrue(_totalDebtAfter.eq(_totalSupplyAfter));
	
    // ensure redemption will increase TCR and individual ICR
    let _tcrAfter = await troveManager.getTCR(_p)
    let _aIcrAfter = await troveManager.getCurrentICR(A, _p)
    console.log('_aIcrAfter=' + _aIcrAfter)
    let _bIcrAfter = await troveManager.getCurrentICR(B, _p)
    let _cIcrAfter = await troveManager.getCurrentICR(C, _p)
    assert.isTrue(_tcrAfter.gt(_tcrBefore));
    assert.isTrue(_aIcrAfter.gt(_aIcrBefore));
    assert.isTrue(_aIcrAfter.eq(toBN('115792089237316195423570985008687907853269984665640564039457584007913129639935')))// max due to zero debt
    assert.isTrue(_bIcrAfter.gt(_bIcrBefore));
    assert.isTrue(_cIcrAfter.gt(_cIcrBefore));	
    
    // Check B, C and A remains active
    assert.isTrue((await troveManager.getTroveStatus(A)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(B)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(C)).eq(toBN('1')))

    // B's debt would be below minimum debt requirement due to redemption share 
    let bEntireDebtAndColl = await troveManager.getEntireDebtAndColl(B)
    let _bTroveColl = bEntireDebtAndColl[1]
    let _bTroveDebtApplied = bEntireDebtAndColl[0]
    await assert.isTrue(_bTroveDebtApplied.lt(MIN_DEBT))
    await assert.isTrue(bEntireDebtAndColl[6].eq(toBN('0')))
    let _bBurnedDebt = bEntireDebtAndColl[4]
	
    // A could not "scavenge" B's Trove since it is liquidatable
    console.log('bICR=' + (await troveManager.getCurrentICR(B, _p)) + ',bColl=' + _bTroveColl + ',_bTroveDebtApplied=' + _bTroveDebtApplied + ',price=' + _p);
    let _newPrice = dec(2, 17)
    await priceFeed.setPrice(_newPrice)
    assert.isTrue((await troveManager.getCurrentICR(B, _newPrice)).lt(MoneyValues._MCR));
    await troveManager.scavengeTrove(B, {from: A})    	
    assert.isTrue((await troveManager.getTroveStatus(B)).eq(toBN('1')))
	
    // now A could liquidate B	
    await troveManager.scavengeTrove(A, {from: A}) 
    let _aDebtBal = await debtToken.balanceOf(A);
    let _aCollBalBefore = await collateralToken.balanceOf(A);
    assert.isTrue(_aDebtBal.gt(_bTroveDebtApplied))
    await stabilityPool.provideToSP(_aDebtBal, ZERO_ADDRESS, {from : A});
    assert.isTrue((await stabilityPool.getTotalDebtDeposits()).gt(_bTroveDebtApplied))
    let _liqCollCompensation = _bTroveColl.mul(MoneyValues._FEE_FLOOR).div(mv._1e18BN)
    let _liqCollToSP = _bTroveColl.sub(_liqCollCompensation)
    let _spCollBalBefore = await stabilityPool.getETH();
    await troveManager.liquidate(B, {from : A})
    let _aCollBalAfter = await collateralToken.balanceOf(A);
    let _spCollBalAfter = await stabilityPool.getETH();
    assert.isTrue((await troveManager.getTroveStatus(B)).eq(toBN('3')))
    assert.isTrue(_aCollBalAfter.sub(_aCollBalBefore).eq(_liqCollCompensation))
    assert.isTrue(_spCollBalAfter.sub(_spCollBalBefore).eq(_liqCollToSP))
	
    _totalDebtAfter = await activePool.getLUSDDebt()
    _totalSupplyAfter = await debtToken.totalSupply()
    _aTroveDebt = await troveManager.getTroveDebt(A);
    _cTroveDebt = await troveManager.getTroveDebt(C);
    assert.isTrue(_totalDebtAfter.eq(_aTroveDebt.add(_cTroveDebt)))
    assert.isTrue(_totalDebtAfter.eq(_totalSupplyAfter));
  })

  it("redeemCollateral(): applyPendingRewards to fulfill redemption share", async () => {
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : A});
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : B});
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : C});
    await collateralToken.deposit({from : A, value: dec(1000, 'ether') });
    await collateralToken.deposit({from : B, value: dec(1000, 'ether') });
    await collateralToken.deposit({from : C, value: dec(1000, 'ether') });
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(6000, 18)), dec(1000, 'ether'), { from: A, value: 0 })
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(18500, 18)), dec(1000, 'ether'), { from: B, value: 0 })
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(31500, 18)), dec(1000, 'ether'), { from: C, value: 0 })

    // A and C send all their tokens to B
    await debtToken.transfer(B, await debtToken.balanceOf(A), {from: A})
    await debtToken.transfer(B, await debtToken.balanceOf(C), {from: C})
	
    // Skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption is 55000 LUSD
    const LUSDRedemption = dec(55000, 18)
    let _p = await priceFeed.getPrice()
    let _tcrBefore = await troveManager.getTCR(_p)
    let _aIcrBefore = await troveManager.getCurrentICR(A, _p)
    let _bIcrBefore = await troveManager.getCurrentICR(B, _p)
    let _cIcrBefore = await troveManager.getCurrentICR(C, _p)
    let _totalDebtBefore = await activePool.getLUSDDebt()
    let _totalSupplyBefore = await debtToken.totalSupply()
    const tx1 = await th.redeemCollateralAndGetTxObject(B, contracts, LUSDRedemption, GAS_PRICE, th._100pct)
    let _totalDebtAfter = await activePool.getLUSDDebt()
    let _totalSupplyAfter = await debtToken.totalSupply()
    let _debtBalanceInAP = await debtToken.balanceOf(activePool.address)
    assert.isTrue(_totalDebtBefore.eq(_totalDebtAfter))
    assert.isTrue(_totalSupplyBefore.eq(_totalSupplyAfter))
    let _redeemedDebtTracker = await activePool.getRedeemedDebt() 
    console.log('_totalDebtBefore=' + _totalDebtBefore + ',_totalDebtAfter=' + _totalDebtAfter + ',_redeemedDebtTracker=' + _redeemedDebtTracker)
    assert.isTrue(_redeemedDebtTracker.eq(toBN(LUSDRedemption)));
    assert.isTrue(_debtBalanceInAP.eq(toBN(LUSDRedemption)));
	
    // check sum of Trove's debt and system debt accounting
    let _aTroveDebt = await troveManager.getTroveDebt(A);
    let _bTroveDebt = await troveManager.getTroveDebt(B);
    let _cTroveDebt = await troveManager.getTroveDebt(C);
    assert.isTrue(_totalDebtAfter.eq(_aTroveDebt.add(_bTroveDebt).add(_cTroveDebt)))
	
    // ensure redemption will increase TCR and individual ICR
    let _tcrAfter = await troveManager.getTCR(_p)
    let _aIcrAfter = await troveManager.getCurrentICR(A, _p)
    console.log('_aIcrAfter=' + _aIcrAfter)
    let _bIcrAfter = await troveManager.getCurrentICR(B, _p)
    let _cIcrAfter = await troveManager.getCurrentICR(C, _p)
    assert.isTrue(_tcrAfter.gt(_tcrBefore));
    assert.isTrue(_aIcrAfter.gt(_aIcrBefore));
    assert.isTrue(_aIcrAfter.eq(toBN('115792089237316195423570985008687907853269984665640564039457584007913129639935')))// max due to zero debt
    assert.isTrue(_bIcrAfter.gt(_bIcrBefore));
    assert.isTrue(_cIcrAfter.gt(_cIcrBefore));	
    
    // Check B, C and A remains active
    assert.isTrue((await troveManager.getTroveStatus(A)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(B)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(C)).eq(toBN('1')))

    // Add some collateral to C's Trove to trigger its redemption share apply
    let _cEntireDebtAndColl = (await troveManager.getEntireDebtAndColl(C))
    let _cDebtApplied = _cEntireDebtAndColl[0]
    let _cDebtRedemptionApplied = _cEntireDebtAndColl[4]
    _totalSupplyBefore = await debtToken.totalSupply()
    await collateralToken.deposit({from : C, value: dec(1, 'ether') });
    await borrowerOperations.addColl(dec(1, 'ether'), { from: C, value: 0 })
    _totalSupplyAfter = await debtToken.totalSupply()
    assert.isTrue(_totalSupplyBefore.sub(_totalSupplyAfter).eq(_cDebtRedemptionApplied));
    _totalDebtAfter = await activePool.getLUSDDebt()
    _aTroveDebt = await troveManager.getTroveDebt(A);
    _bTroveDebt = await troveManager.getTroveDebt(B);
    _cTroveDebt = await troveManager.getTroveDebt(C);
    assert.isTrue(_cDebtApplied.eq(_cTroveDebt))
    assert.isTrue(_totalDebtAfter.eq(_aTroveDebt.add(_bTroveDebt).add(_cTroveDebt)))
    assert.isTrue(_totalDebtAfter.eq(_totalSupplyAfter));
    assert.isTrue((await troveManager.getTroveStatus(C)).eq(toBN('1')))

    // try to "scavenge" B's Trove by triggering its redemption share apply
    let _bEntireDebtAndColl = (await troveManager.getEntireDebtAndColl(B))
    let _bDebtApplied = _bEntireDebtAndColl[0]
    let _bDebtRedemptionApplied = _bEntireDebtAndColl[4]
    _totalSupplyBefore = await debtToken.totalSupply()
    let _bDebtBalBefore = await debtToken.balanceOf(B)
    await collateralToken.deposit({from : B, value: dec(1, 'ether') });
    let _bCollBalBefore = await collateralToken.balanceOf(B)
    assert.isTrue(_bDebtBalBefore.gt(_bDebtApplied));
    console.log('redeemedDebtInAP=' + (await activePool.getRedeemedDebt()));
    await borrowerOperations.addColl(dec(1, 'ether'), { from: B, value: 0 })
    let _bDebtBalAfter = await debtToken.balanceOf(B)
    let _bCollBalAfter = await collateralToken.balanceOf(B)
    _totalSupplyAfter = await debtToken.totalSupply()
    assert.isTrue(_bDebtBalBefore.sub(_bDebtBalAfter).eq(_bDebtApplied));
    assert.isTrue(_bCollBalAfter.sub(_bCollBalBefore).eq(_bEntireDebtAndColl[1]));
    assert.isTrue(_totalSupplyBefore.sub(_totalSupplyAfter).eq(_bDebtRedemptionApplied.add(_bDebtApplied)));
    _totalDebtAfter = await activePool.getLUSDDebt()
    _aTroveDebt = await troveManager.getTroveDebt(A);
    _cTroveDebt = await troveManager.getTroveDebt(C);
    assert.isTrue(_totalDebtAfter.eq(_aTroveDebt.add(_cTroveDebt)))
    assert.isTrue(_totalDebtAfter.eq(_totalSupplyAfter));
    assert.isTrue((await troveManager.getTroveStatus(B)).eq(toBN('4')))

    // try to "scavenge" A's Trove by triggering its redemption share apply
    let _aEntireDebtAndColl = (await troveManager.getEntireDebtAndColl(A))
    let _aDebtFreeDebtApplied = _aEntireDebtAndColl[6]
    let _aDebtRedemptionApplied = _aEntireDebtAndColl[4]
    _totalSupplyBefore = await debtToken.totalSupply()
    let _aDebtBalBefore = await debtToken.balanceOf(A)
    await collateralToken.deposit({from : A, value: dec(1, 'ether') });
    let _aCollBalBefore = await collateralToken.balanceOf(A)
    console.log('redeemedDebtInAP=' + (await activePool.getRedeemedDebt()) + ',_aDebtFreeDebtApplied=' + _aDebtFreeDebtApplied);
    await borrowerOperations.addColl(dec(1, 'ether'), { from: A, value: 0 })
    let _aDebtBalAfter = await debtToken.balanceOf(A)
    _totalSupplyAfter = await debtToken.totalSupply()
    let _aCollBalAfter = await collateralToken.balanceOf(A)
    assert.isTrue(_aDebtBalAfter.sub(_aDebtBalBefore).eq(_aDebtFreeDebtApplied));
    assert.isTrue(_aCollBalAfter.sub(_aCollBalBefore).eq(_aEntireDebtAndColl[1]));
    assert.isTrue(_totalSupplyBefore.sub(_totalSupplyAfter).eq(_aDebtRedemptionApplied.sub(_aDebtFreeDebtApplied)));
    _totalDebtAfter = await activePool.getLUSDDebt()
    _cTroveDebt = await troveManager.getTroveDebt(C);
    assert.isTrue(_totalDebtAfter.eq(_cTroveDebt))
    assert.isTrue(_totalDebtAfter.eq(_totalSupplyAfter));
    assert.isTrue((await troveManager.getTroveStatus(A)).eq(toBN('4')))
  })

  it("multiple rounds of redeemCollateral(): applyPendingRewards to fulfill redemption share", async () => {
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : A});
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : B});
    await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : C});
    await collateralToken.deposit({from : A, value: dec(1000, 'ether') });
    await collateralToken.deposit({from : B, value: dec(1000, 'ether') });
    await collateralToken.deposit({from : C, value: dec(1000, 'ether') });
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(6000, 18)), dec(1000, 'ether'), { from: A, value: 0 })
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(18500, 18)), dec(1000, 'ether'), { from: B, value: 0 })
    await borrowerOperations.openTrove(th._100pct, await getOpenTroveLUSDAmount(dec(31500, 18)), dec(1000, 'ether'), { from: C, value: 0 })

    // A and C send all their tokens to B
    await debtToken.transfer(B, await debtToken.balanceOf(A), {from: A})
    await debtToken.transfer(B, await debtToken.balanceOf(C), {from: C})
	
    // Skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    let _loop = parseInt(th.randNumberRaw(1, 100) + '')
    console.log('Test is creating ' + _loop + ' small troves...');
    let _startAccountIdx = accounts.length / 2
    let smallTroveOwners = accounts.slice(_startAccountIdx - _loop, _startAccountIdx)
    for(let i = 0;i < smallTroveOwners.length;i++){		
        let _owr = smallTroveOwners[i]
        await openTrove({ ICR: toBN(dec(131, 16)), extraParams: { from: _owr } })
        let _totalDebt = await troveManager.getTroveDebt(_owr)
        let _debtInBal = await debtToken.balanceOf(_owr)
        await debtToken.transfer(_owr, _totalDebt.sub(_debtInBal), {from: B})
    }
	
    const smallRedemptionInt = parseInt(th.randNumberRaw(20, 180) + '')
    console.log('Test is going to redeem ' + smallRedemptionInt + ' btUSD for ' + _loop + ' round...');
    const smallRedemption = toBN(dec(smallRedemptionInt, 18)) 
    let _p = await priceFeed.getPrice()
    for(let i = 0;i < _loop;i++){
        let _totalDebtBefore = await activePool.getLUSDDebt()
        let _totalSupplyBefore = await debtToken.totalSupply()
        let _redeemedDebtTrackerBefore = await activePool.getRedeemedDebt() 
        let _debtBalanceInAPBefore = await debtToken.balanceOf(activePool.address)
        await th.redeemCollateralAndGetTxObject(B, contracts, smallRedemption, GAS_PRICE, th._100pct)
        let _totalDebtAfter = await activePool.getLUSDDebt()
        let _totalSupplyAfter = await debtToken.totalSupply()
        let _debtBalanceInAPAfter = await debtToken.balanceOf(activePool.address)
        let _redeemedDebtTrackerAfter = await activePool.getRedeemedDebt()
        assert.isTrue(_totalDebtBefore.eq(_totalDebtAfter))
        assert.isTrue(_totalSupplyBefore.eq(_totalSupplyAfter))
        assert.isTrue(_redeemedDebtTrackerAfter.sub(_redeemedDebtTrackerBefore).eq(smallRedemption));
        assert.isTrue(_debtBalanceInAPAfter.sub(_debtBalanceInAPBefore).eq(smallRedemption));
		
        // close a trove to decrease the total stake and collateral
        let _closedTotalDebtAndColl = await troveManager.getEntireDebtAndColl(smallTroveOwners[i])
        let _closedDebt = _closedTotalDebtAndColl[0];// Trove's debt after redemption share
        let _closedDebtShare = _closedTotalDebtAndColl[4];// Trove's pending debt deduction from redemption share
        assert.isTrue(_closedDebt.gt(toBN('0'))) 
        assert.isTrue(_closedDebtShare.gt(toBN('0'))) 
        assert.isTrue(_closedTotalDebtAndColl[6].eq(toBN('0'))) 
        let _totalSysColl = await troveManager.getEntireSystemColl() 
        let _totalSysStake = await troveManager.totalStakes()
        await borrowerOperations.closeTrove({from: smallTroveOwners[i]});
        let _totalSysCollAfter = await troveManager.getEntireSystemColl() 
        let _totalSysStakeAfter = await troveManager.totalStakes()
        let _redeemedDebtTrackerAgain = await activePool.getRedeemedDebt()
        let _totalSupplyAgain = await debtToken.totalSupply()
        let _totalDebtAgain = await activePool.getLUSDDebt()
        assert.isTrue(_redeemedDebtTrackerAfter.sub(_redeemedDebtTrackerAgain).eq(_closedDebtShare));
        assert.isTrue(_totalSupplyAfter.sub(_totalSupplyAgain).eq(_closedDebtShare.add(_closedDebt)));
        let _sysCollChangeRatio = _totalSysColl.sub(_totalSysCollAfter).mul(mv._1e18BN).div(_totalSysColl)
        let _sysStakeChangeRatio = _totalSysStake.sub(_totalSysStakeAfter).mul(mv._1e18BN).div(_totalSysStake)
        assert.isTrue(_totalDebtAfter.sub(_totalDebtAgain).eq(_closedDebtShare.add(_closedDebt)));
        assert.isTrue(_totalDebtAfter.sub(_totalDebtAgain).eq(_closedDebtShare.add(_closedDebt)));
        console.log('redemption round[' + i + ']:_sysStakeChangeRatio=' + _sysStakeChangeRatio + ',_sysCollChangeRatio=' + _sysCollChangeRatio + ",diff=" + _sysCollChangeRatio.sub(_sysStakeChangeRatio))
        assert.isTrue(_sysStakeChangeRatio.lte(_sysCollChangeRatio));
        
        // check ICR of A/B/C
        let _aIcrAfter = await troveManager.getCurrentICR(A, _p)
        let _bIcrAfter = await troveManager.getCurrentICR(B, _p)
        let _cIcrAfter = await troveManager.getCurrentICR(C, _p)
        assert.isTrue(_aIcrAfter.gt(_bIcrAfter))
        assert.isTrue(_bIcrAfter.gt(_cIcrAfter))
		
        // check sum of Trove's asset and system accouting
        let _sumTolerance = 10000 // compared in 1e18
        let _totalSysDebtAfter = await troveManager.getEntireSystemDebt() 
        let _troveCount = await troveManager.getTroveOwnersCount()
        let _sumOfDebt = toBN('0')
        let _sumOfColl = toBN('0')
        let _sumOfPendingDebtShare = toBN('0')
        for (let i = 0;i < _troveCount;i++){
             let _owr = await troveManager.getTroveFromTroveOwnersArray(i);
             let _owrEntireDebtAndColl = await troveManager.getEntireDebtAndColl(_owr)
             _sumOfColl = _sumOfColl.add(_owrEntireDebtAndColl[1])
             _sumOfDebt = _sumOfDebt.add(_owrEntireDebtAndColl[0])
             _sumOfPendingDebtShare = _sumOfPendingDebtShare.add(_owrEntireDebtAndColl[4])
        }
        console.log('_totalSysCollAfter=' + _totalSysCollAfter + ',_totalSysDebtAfter=' + _totalSysDebtAfter + ',_redeemedDebtTrackerAgain=' + _redeemedDebtTrackerAgain)
        console.log('_sumOfColl=' + _sumOfColl + ',_sumOfDebt=' + _sumOfDebt + ',_sumOfPendingDebtShare=' + _sumOfPendingDebtShare)
        th.assertIsApproximatelyEqual(_totalSysCollAfter, _sumOfColl, _sumTolerance);
        th.assertIsApproximatelyEqual(_redeemedDebtTrackerAgain, _sumOfPendingDebtShare, _sumTolerance);
        th.assertIsApproximatelyEqual(_totalSysDebtAfter, _sumOfDebt.add(_sumOfPendingDebtShare), _sumTolerance);
    }
  })

  it('redeemCollateral(): doesnt perform the final partial redemption in the sequence if the hint is out-of-date', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(363, 16)), extraLUSDAmount: dec(5, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(344, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(333, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })

    const partialRedemptionAmount = toBN(2)
    const fullfilledRedemptionAmount = C_netDebt.add(B_netDebt)
    const redemptionAmount = fullfilledRedemptionAmount.add(partialRedemptionAmount)

    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_ETHBalance_Before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_Before = await debtToken.balanceOf(dennis)

    const price = await priceFeed.getPrice()
    let _p = dec(200, 18);
    assert.equal(price, _p)

    // --- TEST --- 

    const frontRunRedepmtion = toBN(dec(1, 18))
    // Oops, another transaction gets in the way
    {      
      // skip bootstrapping phase
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

      // Alice redeems 1 LUSD from Carol's Trove
      await debtToken.approve(troveManager.address, frontRunRedepmtion, {from : alice});
      await troveManager.redeemCollateral(
        frontRunRedepmtion, th._100pct,
        { from: alice }
      )
    }

    // Dennis tries to redeem as well
    await debtToken.approve(troveManager.address, redemptionAmount, {from : dennis});
    const redemptionTx = await troveManager.redeemCollateral(
      redemptionAmount, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const ETHFee = th.getEmittedRedemptionValues(redemptionTx)[3]
	  
    const dennis_ETHBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedETH = dennis_ETHBalance_After.sub(dennis_ETHBalance_Before)

    const expectedTotalETHDrawn = redemptionAmount.mul(mv._1e18BN).div(toBN(_p)) // redempted LUSD converted to ETH, at ETH:USD price 200
    const expectedReceivedETH = expectedTotalETHDrawn.sub(ETHFee);//.sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used

    th.assertIsApproximatelyEqual(expectedReceivedETH, receivedETH)

    const dennis_LUSDBalance_After = (await debtToken.balanceOf(dennis)).toString()
    th.assertIsApproximatelyEqual(dennis_LUSDBalance_After, dennis_LUSDBalance_Before.sub(redemptionAmount))
  })

  // active debt cannot be zero, as there’s a positive min debt enforced, and at least a trove must exist
  it.skip("redeemCollateral(): can redeem if there is zero active debt but non-zero debt in DefaultPool", async () => {
    // --- SETUP ---

    const amount = await getOpenTroveLUSDAmount(dec(110, 18))
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(133, 16)), extraLUSDAmount: amount, extraParams: { from: bob } })

    await debtToken.transfer(carol, amount, { from: bob })

    const price = dec(100, 18)
    await priceFeed.setPrice(price)

    // Liquidate Bob's Trove
    await troveManager.liquidateTroves(1)

    // --- TEST --- 

    const carol_ETHBalance_Before = toBN(await collateralToken.balanceOf(carol))

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const redemptionTx = await troveManager.redeemCollateral(
      amount,
      th._100pct,
      {
        from: carol,
        gasPrice: GAS_PRICE
      }
    )

    const ETHFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const carol_ETHBalance_After = toBN(await collateralToken.balanceOf(carol))

    const expectedTotalETHDrawn = toBN(amount).div(toBN(100)) // convert 100 LUSD to ETH at ETH:USD price of 100
    const expectedReceivedETH = expectedTotalETHDrawn.sub(ETHFee)

    const receivedETH = carol_ETHBalance_After.sub(carol_ETHBalance_Before)
    assert.isTrue(expectedReceivedETH.eq(receivedETH))

    const carol_LUSDBalance_After = (await debtToken.balanceOf(carol)).toString()
    assert.equal(carol_LUSDBalance_After, '0')
  })

  it("redeemCollateral(): doesn't touch Troves with ICR < 110%", async () => {
    // --- SETUP ---

    const { netDebt: A_debt } = await openTrove({ ICR: toBN(dec(13, 18)), extraParams: { from: alice } })
    const { debtAmount: B_lusdAmount, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(133, 16)), extraLUSDAmount: A_debt, extraParams: { from: bob } })

    await debtToken.transfer(carol, B_lusdAmount, { from: bob })

    // Put Bob's Trove below 110% ICR
    const price = dec(100, 18)
    await priceFeed.setPrice(price)

    // --- TEST --- 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await debtToken.approve(troveManager.address, A_debt, {from : carol});
    await troveManager.redeemCollateral(
      A_debt,
      th._100pct,
      { from: carol }
    );

    // Alice's Trove was cleared of debt
    const { debt: alice_Debt_After } = await troveManager.Troves(alice)
    let _aTotalDebtAndColl = await troveManager.getEntireDebtAndColl(alice);
    assert.equal(alice_Debt_After.toString(), _aTotalDebtAndColl[0].add(_aTotalDebtAndColl[4]).toString())

    // Bob's Trove was left untouched
    const { debt: bob_Debt_After } = await troveManager.Troves(bob)
    let _bTotalDebtAndColl = await troveManager.getEntireDebtAndColl(bob);
    th.assertIsApproximatelyEqual(bob_Debt_After.toString(), _bTotalDebtAndColl[0].add(_bTotalDebtAndColl[4]).toString())
  });

  it("redeemCollateral(): finds the last Trove with ICR == 110% even if there is more than one", async () => {
    // --- SETUP ---
    const amount1 = toBN(dec(100, 18))
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: amount1, extraParams: { from: alice } })
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: amount1, extraParams: { from: bob } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: amount1, extraParams: { from: carol } })
    const redemptionAmount = C_totalDebt.add(B_totalDebt).add(A_totalDebt)
    const { totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(195, 16)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    // This will put Dennis slightly below 110%, and everyone else exactly at 110%
    const price = '110' + _18_zeros
    await priceFeed.setPrice(price)

    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: dec(10, 18), extraParams: { from: whale } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await debtToken.approve(troveManager.address, redemptionAmount, {from : dennis});
    const tx = await troveManager.redeemCollateral(
      redemptionAmount,
      th._100pct,
      { from: dennis }
    )
    
    const { debt: alice_Debt_After } = await troveManager.Troves(alice)
    let _aTotalDebtAndColl = await troveManager.getEntireDebtAndColl(alice);
    assert.equal(alice_Debt_After.toString(), _aTotalDebtAndColl[0].add(_aTotalDebtAndColl[4]).toString())

    const { debt: bob_Debt_After } = await troveManager.Troves(bob)
    let _bTotalDebtAndColl = await troveManager.getEntireDebtAndColl(bob);
    assert.equal(bob_Debt_After.toString(), _bTotalDebtAndColl[0].add(_bTotalDebtAndColl[4]).toString())

    const { debt: carol_Debt_After } = await troveManager.Troves(carol)
    let _cTotalDebtAndColl = await troveManager.getEntireDebtAndColl(carol);
    assert.equal(carol_Debt_After.toString(), _cTotalDebtAndColl[0].add(_cTotalDebtAndColl[4]).toString())

    const { debt: dennis_Debt_After } = await troveManager.Troves(dennis)
    let _dTotalDebtAndColl = await troveManager.getEntireDebtAndColl(dennis);
    th.assertIsApproximatelyEqual(dennis_Debt_After.toString(), _dTotalDebtAndColl[0].add(_dTotalDebtAndColl[4]).toString())
  });

  it("redeemCollateral(): reverts when TCR < MCR", async () => {
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(196, 16)), extraParams: { from: dennis } })

    // This will put Dennis slightly below 110%, and everyone else exactly at 110%
  
    await priceFeed.setPrice('110' + _18_zeros)
    const price = await priceFeed.getPrice()
    
    const TCR = (await th.getTCR(contracts))
    assert.isTrue(TCR.lt(toBN('1100000000000000000')))

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await assertRevert(th.redeemCollateral(carol, contracts, GAS_PRICE, dec(270, 18)), "TroveManager: Cannot redeem when TCR < MCR")
  });

  it("redeemCollateral(): reverts when argument _amount is 0", async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 500LUSD to Erin, the would-be redeemer
    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(500, 18), extraParams: { from: alice } })
    await debtToken.transfer(erin, dec(500, 18), { from: alice })

    // B, C and D open troves
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: dennis } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Erin attempts to redeem with _amount = 0
    const redemptionTxPromise = troveManager.redeemCollateral(0, th._100pct, { from: erin })
    await assertRevert(redemptionTxPromise, "TroveManager: Amount must be greater than zero")
  })

  it("redeemCollateral(): reverts if max fee > 100%", async () => {
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(30, 18), extraParams: { from: C } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: D } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE, dec(2, 18)), "Max fee percentage must be between 0.5% and 100%")
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE, '1000000000000000001'), "Max fee percentage must be between 0.5% and 100%")
  })

  it("redeemCollateral(): reverts if max fee < 0.5%", async () => { 
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(30, 18), extraParams: { from: C } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: D } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE, 0), "Max fee percentage must be between 0.5% and 100%")
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE, dec(11, 17)), "Max fee percentage must be between 0.5% and 100%")
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE, '4999999999999999'), "Max fee percentage must be between 0.5% and 100%")
  })

  it("redeemCollateral(): reverts if fee exceeds max fee percentage", async () => {
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(80, 18), extraParams: { from: A } })
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(90, 18), extraParams: { from: B } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const expectedTotalSupply = A_totalDebt.add(B_totalDebt).add(C_totalDebt)

    // Check total LUSD supply
    const totalSupply = await debtToken.totalSupply()
    th.assertIsApproximatelyEqual(totalSupply, expectedTotalSupply)

    await troveManager.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption is 27 USD: a redemption that incurs a fee of 27/(270 * 2) = 5%
    const attemptedLUSDRedemption = expectedTotalSupply.div(toBN(10))

    // Max fee is <5%
    const lessThan5pct = '49999999999999999'
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, GAS_PRICE, lessThan5pct), "Fee exceeded provided maximum")
  
    await troveManager.setBaseRate(0)  // artificially zero the baseRate
    
    // Max fee is 1%
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, GAS_PRICE, dec(1, 16)), "Fee exceeded provided maximum")
  
    await troveManager.setBaseRate(0)

     // Max fee is 3.754%
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, GAS_PRICE, dec(3754, 13)), "Fee exceeded provided maximum")
  
    await troveManager.setBaseRate(0)

    // Max fee is 0.5%
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, GAS_PRICE, dec(5, 15)), "Fee exceeded provided maximum")
  })

  it("redeemCollateral(): succeeds if fee is less than max fee percentage", async () => {
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(9500, 18), extraParams: { from: A } })
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(395, 16)), extraLUSDAmount: dec(9000, 18), extraParams: { from: B } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(390, 16)), extraLUSDAmount: dec(10000, 18), extraParams: { from: C } })
    const expectedTotalSupply = A_totalDebt.add(B_totalDebt).add(C_totalDebt)

    // Check total LUSD supply
    const totalSupply = await debtToken.totalSupply()
    th.assertIsApproximatelyEqual(totalSupply, expectedTotalSupply)

    await troveManager.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption fee with 10% of the supply will be 0.5% + 1/(10*2)
    const attemptedLUSDRedemption = expectedTotalSupply.div(toBN(10))

    // Attempt with maxFee > 5.5%
    const price = await priceFeed.getPrice()
    const ETHDrawn = attemptedLUSDRedemption.mul(mv._1e18BN).div(price)
    const slightlyMoreThanFee = (await troveManager.getRedemptionFeeWithDecayForRedeemer(A, ETHDrawn))
    const tx1 = await th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, slightlyMoreThanFee)
    assert.isTrue(tx1.receipt.status)

    await troveManager.setBaseRate(0)  // Artificially zero the baseRate
    
    // Attempt with maxFee = 5.5%
    const exactSameFee = (await troveManager.getRedemptionFeeWithDecayForRedeemer(C, ETHDrawn))
    const tx2 = await th.redeemCollateralAndGetTxObject(C, contracts, attemptedLUSDRedemption, exactSameFee)
    assert.isTrue(tx2.receipt.status)

    await troveManager.setBaseRate(0)

     // Max fee is 10%
    const tx3 = await th.redeemCollateralAndGetTxObject(B, contracts, attemptedLUSDRedemption, dec(1, 17))
    assert.isTrue(tx3.receipt.status)

    await troveManager.setBaseRate(0)

    // Max fee is 37.659%
    const tx4 = await th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, dec(37659, 13))
    assert.isTrue(tx4.receipt.status)

    await troveManager.setBaseRate(0)

    // Max fee is 100%
    const tx5 = await th.redeemCollateralAndGetTxObject(C, contracts, attemptedLUSDRedemption, dec(1, 18))
    assert.isTrue(tx5.receipt.status)
  })

  it("redeemCollateral(): doesn't affect the Stability Pool deposits or ETH gain of redeemed-from troves", async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // B, C, D, F open trove
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: bob } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(195, 16)), extraLUSDAmount: dec(200, 18), extraParams: { from: carol } })
    const { totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(400, 18), extraParams: { from: dennis } })
    const { totalDebt: F_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: flyn } })

    const redemptionAmount = B_totalDebt.add(C_totalDebt).add(D_totalDebt).add(F_totalDebt)
    // Alice opens trove and transfers LUSD to Erin, the would-be redeemer
    await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: redemptionAmount, extraParams: { from: alice } })
    await debtToken.transfer(erin, redemptionAmount, { from: alice })

    // B, C, D deposit some of their tokens to the Stability Pool
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, { from: bob })
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: carol })
    await stabilityPool.provideToSP(dec(200, 18), ZERO_ADDRESS, { from: dennis })

    let price = await priceFeed.getPrice()
    const bob_ICR_before = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_before = await troveManager.getCurrentICR(carol, price)
    const dennis_ICR_before = await troveManager.getCurrentICR(dennis, price)

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    assert.isTrue((await troveManager.getTroveStatus(flyn)).eq(toBN('1')))

    // Liquidate Flyn
    await troveManager.liquidate(flyn)
    assert.isFalse((await troveManager.getTroveStatus(flyn)).eq(toBN('1')))

    // Price bounces back, bringing B, C, D back above MCR
    await priceFeed.setPrice(dec(200, 18))

    const bob_SPDeposit_before = (await stabilityPool.getCompoundedDebtDeposit(bob)).toString()
    const carol_SPDeposit_before = (await stabilityPool.getCompoundedDebtDeposit(carol)).toString()
    const dennis_SPDeposit_before = (await stabilityPool.getCompoundedDebtDeposit(dennis)).toString()

    const bob_ETHGain_before = (await stabilityPool.getDepositorETHGain(bob)).toString()
    const carol_ETHGain_before = (await stabilityPool.getDepositorETHGain(carol)).toString()
    const dennis_ETHGain_before = (await stabilityPool.getDepositorETHGain(dennis)).toString()

    // Check the remaining LUSD and ETH in Stability Pool after liquidation is non-zero
    const LUSDinSP = await stabilityPool.getTotalDebtDeposits()
    const ETHinSP = await stabilityPool.getETH()
    assert.isTrue(LUSDinSP.gte(mv._zeroBN))
    assert.isTrue(ETHinSP.gte(mv._zeroBN))

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Erin redeems LUSD
    await th.redeemCollateral(erin, contracts, redemptionAmount, th._100pct)

    price = await priceFeed.getPrice()
    const bob_ICR_after = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_after = await troveManager.getCurrentICR(carol, price)
    const dennis_ICR_after = await troveManager.getCurrentICR(dennis, price)

    // Check ICR of B, C and D troves has increased,i.e. they have been hit by redemptions
    assert.isTrue(bob_ICR_after.gte(bob_ICR_before))
    assert.isTrue(carol_ICR_after.gte(carol_ICR_before))
    assert.isTrue(dennis_ICR_after.gte(dennis_ICR_before))

    const bob_SPDeposit_after = (await stabilityPool.getCompoundedDebtDeposit(bob)).toString()
    const carol_SPDeposit_after = (await stabilityPool.getCompoundedDebtDeposit(carol)).toString()
    const dennis_SPDeposit_after = (await stabilityPool.getCompoundedDebtDeposit(dennis)).toString()

    const bob_ETHGain_after = (await stabilityPool.getDepositorETHGain(bob)).toString()
    const carol_ETHGain_after = (await stabilityPool.getDepositorETHGain(carol)).toString()
    const dennis_ETHGain_after = (await stabilityPool.getDepositorETHGain(dennis)).toString()

    // Check B, C, D Stability Pool deposits and ETH gain have not been affected by redemptions from their troves
    assert.equal(bob_SPDeposit_before, bob_SPDeposit_after)
    assert.equal(carol_SPDeposit_before, carol_SPDeposit_after)
    assert.equal(dennis_SPDeposit_before, dennis_SPDeposit_after)

    assert.equal(bob_ETHGain_before, bob_ETHGain_after)
    assert.equal(carol_ETHGain_before, carol_ETHGain_after)
    assert.equal(dennis_ETHGain_before, dennis_ETHGain_after)
  })

  it("redeemCollateral(): caller can redeem their entire LUSDToken balance", async () => {
    const { collateral: W_coll, totalDebt: W_totalDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 400 LUSD to Erin, the would-be redeemer
    const { collateral: A_coll, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(400, 18), extraParams: { from: alice } })
    await debtToken.transfer(erin, dec(400, 18), { from: alice })

    // Check Erin's balance before
    const erin_balance_before = await debtToken.balanceOf(erin)
    assert.equal(erin_balance_before, dec(400, 18))

    // B, C, D open trove
    const { collateral: B_coll, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(590, 18), extraParams: { from: bob } })
    const { collateral: C_coll, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: carol } })
    const { collateral: D_coll, totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(500, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: dennis } })

    const totalDebt = W_totalDebt.add(A_totalDebt).add(B_totalDebt).add(C_totalDebt).add(D_totalDebt)
    const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

    // Get active debt and coll before redemption
    const activePool_debt_before = await activePool.getLUSDDebt()
    const activePool_coll_before = await activePool.getETH()

    th.assertIsApproximatelyEqual(activePool_debt_before, totalDebt)
    assert.equal(activePool_coll_before.toString(), totalColl)

    const price = await priceFeed.getPrice()

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Erin attempts to redeem 400 LUSD
    await debtToken.approve(troveManager.address, dec(400, 18), {from : erin});
    await troveManager.redeemCollateral(
      dec(400, 18), th._100pct,
      { from: erin })

    // Check activePool debt remains the same
    const activePool_debt_after = await activePool.getLUSDDebt()
    assert.isTrue(activePool_debt_before.eq(activePool_debt_after))
    // check activePool redemption debt tracker is correct
    assert.isTrue((await activePool.getRedeemedDebt()).eq(toBN(dec(400, 18))))

    /* Check ActivePool coll reduced by $400 worth of Ether: at ETH:USD price of $200, this should be 2 ETH.

    therefore remaining ActivePool ETH should be 198 */
    const activePool_coll_after = await activePool.getETH()
    // console.log(`activePool_coll_after: ${activePool_coll_after}`)
    assert.equal(activePool_coll_after.toString(), activePool_coll_before.sub(toBN(dec(2, 18))))

    // Check Erin's balance after
    const erin_balance_after = (await debtToken.balanceOf(erin)).toString()
    assert.equal(erin_balance_after, '0')
  })

  it("redeemCollateral(): reverts when requested redemption amount exceeds caller's LUSD token balance", async () => {
    const { collateral: W_coll, totalDebt: W_totalDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 400 LUSD to Erin, the would-be redeemer
    const { collateral: A_coll, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(400, 18), extraParams: { from: alice } })
    await debtToken.transfer(erin, dec(400, 18), { from: alice })

    // Check Erin's balance before
    const erin_balance_before = await debtToken.balanceOf(erin)
    assert.equal(erin_balance_before, dec(400, 18))

    // B, C, D open trove
    const { collateral: B_coll, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(590, 18), extraParams: { from: bob } })
    const { collateral: C_coll, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: carol } })
    const { collateral: D_coll, totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(500, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: dennis } })

    const totalDebt = W_totalDebt.add(A_totalDebt).add(B_totalDebt).add(C_totalDebt).add(D_totalDebt)
    const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

    // Get active debt and coll before redemption
    const activePool_debt_before = await activePool.getLUSDDebt()
    const activePool_coll_before = (await activePool.getETH()).toString()

    th.assertIsApproximatelyEqual(activePool_debt_before, totalDebt)
    assert.equal(activePool_coll_before, totalColl)

    const price = await priceFeed.getPrice()

    let firstRedemptionHint
    let partialRedemptionHintNICR

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Erin tries to redeem 1000 LUSD
    try {

      const redemptionTx = await troveManager.redeemCollateral(
        dec(1000, 18), th._100pct,
        { from: erin })

      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "Requested redemption amount must be <= user's debt token balance")
    }

    // Erin tries to redeem 401 LUSD
    try {

      const redemptionTx = await troveManager.redeemCollateral(
        '401000000000000000000', th._100pct,
        { from: erin })
      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "Requested redemption amount must be <= user's debt token balance")
    }

    // Erin tries to redeem 239482309 LUSD
    try {      

      const redemptionTx = await troveManager.redeemCollateral(
        '239482309000000000000000000', th._100pct,
        { from: erin })
      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "Requested redemption amount must be <= user's debt token balance")
    }

    // Erin tries to redeem 2^256 - 1 LUSD
    const maxBytes32 = toBN('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')

    try {      

      const redemptionTx = await troveManager.redeemCollateral(
        maxBytes32, th._100pct,
        { from: erin })
      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "Requested redemption amount must be <= user's debt token balance")
    }
  })

  it("redeemCollateral(): value of issued ETH == face value of redeemed LUSD (assuming 1 LUSD has value of $1)", async () => {
    const { collateral: W_coll } = await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 1000 LUSD each to Erin, Flyn, Graham
    const { collateral: A_coll, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(4990, 18), extraParams: { from: alice } })
    await debtToken.transfer(erin, dec(1000, 18), { from: alice })
    await debtToken.transfer(flyn, dec(1000, 18), { from: alice })
    await debtToken.transfer(graham, dec(1000, 18), { from: alice })

    // B, C, D open trove
    const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(1590, 18), extraParams: { from: bob } })
    const { collateral: C_coll } = await openTrove({ ICR: toBN(dec(600, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: carol } })
    const { collateral: D_coll } = await openTrove({ ICR: toBN(dec(800, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: dennis } })

    const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

    const price = await priceFeed.getPrice()

    const _120_LUSD = '120000000000000000000'
    const _373_LUSD = '373000000000000000000'
    const _950_LUSD = '950000000000000000000'

    // Check Ether in activePool
    const activeETH_0 = await activePool.getETH()
    assert.equal(activeETH_0, totalColl.toString());

    let firstRedemptionHint
    let partialRedemptionHintNICR


    // Erin redeems 120 LUSD

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await debtToken.approve(troveManager.address, _120_LUSD, {from : erin});
    const redemption_1 = await troveManager.redeemCollateral(
      _120_LUSD, th._100pct,
      { from: erin })

    assert.isTrue(redemption_1.receipt.status);

    /* 120 LUSD redeemed.  Expect $120 worth of ETH removed. At ETH:USD price of $200, 
    ETH removed = (120/200) = 0.6 ETH
    Total active ETH = 280 - 0.6 = 279.4 ETH */

    const activeETH_1 = await activePool.getETH()
    assert.equal(activeETH_1.toString(), activeETH_0.sub(toBN(_120_LUSD).mul(mv._1e18BN).div(price)));

    // Flyn redeems 373 LUSD
    await debtToken.approve(troveManager.address, _373_LUSD, {from : flyn});
    const redemption_2 = await troveManager.redeemCollateral(
      _373_LUSD, th._100pct,
      { from: flyn })

    assert.isTrue(redemption_2.receipt.status);

    /* 373 LUSD redeemed.  Expect $373 worth of ETH removed. At ETH:USD price of $200, 
    ETH removed = (373/200) = 1.865 ETH
    Total active ETH = 279.4 - 1.865 = 277.535 ETH */
    const activeETH_2 = await activePool.getETH()
    assert.equal(activeETH_2.toString(), activeETH_1.sub(toBN(_373_LUSD).mul(mv._1e18BN).div(price)));

    // Graham redeems 950 LUSD
    await debtToken.approve(troveManager.address, _950_LUSD, {from : graham});
    const redemption_3 = await troveManager.redeemCollateral(
      _950_LUSD, th._100pct,
      { from: graham })

    assert.isTrue(redemption_3.receipt.status);

    /* 950 LUSD redeemed.  Expect $950 worth of ETH removed. At ETH:USD price of $200, 
    ETH removed = (950/200) = 4.75 ETH
    Total active ETH = 277.535 - 4.75 = 272.785 ETH */
    const activeETH_3 = (await activePool.getETH()).toString()
    assert.equal(activeETH_3.toString(), activeETH_2.sub(toBN(_950_LUSD).mul(mv._1e18BN).div(price)));
  })

  // it doesn’t make much sense as there’s now min debt enforced and at least one trove must remain active
  // the only way to test it is before any trove is opened
  it("redeemCollateral(): reverts if there is zero outstanding system debt", async () => {
    // --- SETUP --- illegally mint LUSD to Bob
    await debtToken.unprotectedMint(bob, dec(100, 18))

    assert.equal((await debtToken.balanceOf(bob)), dec(100, 18))

    const price = await priceFeed.getPrice()

    // Bob tries to redeem his illegally obtained LUSD
    try {
      const redemptionTx = await troveManager.redeemCollateral(
        dec(100, 18), th._100pct,
        { from: bob })
    } catch (error) {
      assert.include(error.message, "VM Exception while processing transaction")
    }

    // assert.isFalse(redemptionTx.receipt.status);
  })

  it("redeemCollateral(): reverts if caller's tries to redeem more than the outstanding system debt", async () => {
    // --- SETUP --- illegally mint LUSD to Bob
    await debtToken.unprotectedMint(bob, '101000000000000000000')

    assert.equal((await debtToken.balanceOf(bob)), '101000000000000000000')

    const { collateral: C_coll, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(1000, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: carol } })
    const { collateral: D_coll, totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(1000, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: dennis } })

    const totalDebt = C_totalDebt.add(D_totalDebt)
    th.assertIsApproximatelyEqual((await activePool.getLUSDDebt()).toString(), totalDebt)

    const price = await priceFeed.getPrice()

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Bob attempts to redeem his ill-gotten 101 LUSD, from a system that has 100 LUSD outstanding debt
    try {
      const redemptionTx = await troveManager.redeemCollateral(
        totalDebt.add(toBN(dec(100, 18))), th._100pct,
        { from: bob })
    } catch (error) {
      assert.include(error.message, "VM Exception while processing transaction")
    }
  })

  // Redemption fees 
  it("redeemCollateral(): a redemption made when base rate is zero increases the base rate", async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await troveManager.baseRate(), '0')

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const A_balanceBefore = await debtToken.balanceOf(A)

    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    assert.isTrue((await troveManager.baseRate()).gt(toBN('0')))
  })

  it("redeemCollateral(): a redemption made when base rate is non-zero increases the base rate, for negligible time passed", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 SATO
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await troveManager.baseRate(), '0')

    const A_balanceBefore = await debtToken.balanceOf(A)
    const B_balanceBefore = await debtToken.balanceOf(B)

    // A redeems 10 LUSD
    const redemptionTx_A = await th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE)
    const timeStamp_A = await th.getTimestampFromTx(redemptionTx_A, web3)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await troveManager.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // B redeems 10 LUSD
    const redemptionTx_B = await th.redeemCollateralAndGetTxObject(B, contracts, dec(10, 18), GAS_PRICE)
    const timeStamp_B = await th.getTimestampFromTx(redemptionTx_B, web3)

    // Check B's balance has decreased by 10 LUSD
    assert.equal(await debtToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check negligible time difference (< 1 minute) between txs
    assert.isTrue(Number(timeStamp_B) - Number(timeStamp_A) < 60)

    const baseRate_2 = await troveManager.baseRate()

    // Check baseRate has again increased
    assert.isTrue(baseRate_2.gt(baseRate_1))
  })

  it("redeemCollateral(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation [ @skip-on-coverage ]", async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const A_balanceBefore = await debtToken.balanceOf(A)

    // A redeems 10 LUSD
    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(A_balanceBefore.sub(await debtToken.balanceOf(A)), dec(10, 18))

    // Check baseRate is now non-zero
    const baseRate_1 = await troveManager.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    const lastFeeOpTime_1 = await troveManager.lastFeeOperationTime()

    // 45 seconds pass
    th.fastForwardTime(45, web3.currentProvider)

    // Borrower A triggers a fee
    await th.redeemCollateral(A, contracts, dec(1, 18), GAS_PRICE)

    const lastFeeOpTime_2 = await troveManager.lastFeeOperationTime()

    // Check that the last fee operation time did not update, as borrower A's 2nd redemption occured
    // since before minimum interval had passed 
    assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1))

    // 15 seconds passes
    th.fastForwardTime(15, web3.currentProvider)

    // Check that now, at least one hour has passed since lastFeeOpTime_1
    const timeNow = await th.getLatestBlockTimestamp(web3)
    assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(3600))

    // Borrower A triggers a fee
    await th.redeemCollateral(A, contracts, dec(1, 18), GAS_PRICE)

    const lastFeeOpTime_3 = await troveManager.lastFeeOperationTime()

    // Check that the last fee operation time DID update, as A's 2rd redemption occured
    // after minimum interval had passed 
    assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1))
  })

  it("redeemCollateral(): a redemption made at zero base rate send a non-zero ETHFee to SATO staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 SATO
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await troveManager.baseRate(), '0')

    // Check SATO Staking contract balance before is zero
    const satoStakingBalance_Before = await collateralToken.balanceOf(satoStaking.address)
    assert.equal(satoStakingBalance_Before, '0')

    const A_balanceBefore = await debtToken.balanceOf(A)

    // A redeems 10 LUSD
    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await troveManager.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // Check SATO Staking contract balance after is non-zero
    const satoStakingBalance_After = toBN(await collateralToken.balanceOf(satoStaking.address))
    assert.isTrue(satoStakingBalance_After.gt(toBN('0')))
  })

  it("redeemCollateral(): a redemption made at zero base increases the ETH-fees-per-SATO-staked in SATO Staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 SATO
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await troveManager.baseRate(), '0')

    // Check SATO Staking ETH-fees-per-SATOs-staked before is zero
    const F_ETH_Before = await satoStaking.F_ETH()
    assert.equal(F_ETH_Before, '0')

    const A_balanceBefore = await debtToken.balanceOf(A)

    // A redeems 10 LUSD
    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await troveManager.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // Check SATO Staking ETH-fees-per-SATO-staked after is non-zero
    const F_ETH_After = await satoStaking.F_ETH()
    assert.isTrue(F_ETH_After.gt('0'))
  })

  it("redeemCollateral(): a redemption made at a non-zero base rate send a non-zero ETHFee to SATO staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 SATO
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await troveManager.baseRate(), '0')

    const A_balanceBefore = await debtToken.balanceOf(A)
    const B_balanceBefore = await debtToken.balanceOf(B)

    // A redeems 10 LUSD
    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await troveManager.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    const satoStakingBalance_Before = toBN(await collateralToken.balanceOf(satoStaking.address))

    // B redeems 10 LUSD
    await th.redeemCollateral(B, contracts, dec(10, 18), GAS_PRICE)

    // Check B's balance has decreased by 10 LUSD
    assert.equal(await debtToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

    const satoStakingBalance_After = toBN(await collateralToken.balanceOf(satoStaking.address))

    // check SATO Staking balance has increased
    assert.isTrue(satoStakingBalance_After.gt(satoStakingBalance_Before))
  })

  it("redeemCollateral(): a redemption made at a non-zero base rate increases ETH-per-SATO-staked in the staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 SATO
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await satoStaking.stake(dec(1, 18), { from: bountyAddress })

    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await troveManager.baseRate(), '0')

    const A_balanceBefore = await debtToken.balanceOf(A)
    const B_balanceBefore = await debtToken.balanceOf(B)

    // A redeems 10 LUSD
    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await troveManager.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // Check SATO Staking ETH-fees-per-SATO-staked before is zero
    const F_ETH_Before = await satoStaking.F_ETH()

    // B redeems 10 LUSD
    await th.redeemCollateral(B, contracts, dec(10, 18), GAS_PRICE)

    // Check B's balance has decreased by 10 LUSD
    assert.equal(await debtToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

    const F_ETH_After = await satoStaking.F_ETH()

    // check SATO Staking balance has increased
    assert.isTrue(F_ETH_After.gt(F_ETH_Before))
  })

  it("redeemCollateral(): a redemption sends the ETH remainder (ETHDrawn - ETHFee) to the redeemer", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 SATO
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    const { totalDebt: W_totalDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const totalDebt = W_totalDebt.add(A_totalDebt).add(B_totalDebt).add(C_totalDebt)

    const A_balanceBefore = toBN(await collateralToken.balanceOf(A))

    // Confirm baseRate before redemption is 0
    const baseRate = await troveManager.baseRate()
    assert.equal(baseRate, '0')

    // Check total LUSD supply
    const activeLUSD = await activePool.getLUSDDebt()
    const defaultLUSD = await defaultPool.getLUSDDebt()

    const totalLUSDSupply = activeLUSD.add(defaultLUSD)
    th.assertIsApproximatelyEqual(totalLUSDSupply, totalDebt)

    // A redeems 9 LUSD
    const redemptionAmount = toBN(dec(9, 18))
    const gasUsed = await th.redeemCollateral(A, contracts, redemptionAmount, GAS_PRICE)

    /*
    At ETH:USD price of 200:
    ETHDrawn = (9 / 200) = 0.045 ETH
    ETHfee = (0.005 + (1/2) *( 9/260)) * ETHDrawn = 0.00100384615385 ETH
    ETHRemainder = 0.045 - 0.001003... = 0.0439961538462
    */

    const A_balanceAfter = toBN(await collateralToken.balanceOf(A))

    // check A's ETH balance has increased by 0.045 ETH 
    const price = await priceFeed.getPrice()
    const ETHDrawn = redemptionAmount.mul(mv._1e18BN).div(price)
    th.assertIsApproximatelyEqual(
      A_balanceAfter.sub(A_balanceBefore),
      ETHDrawn.sub(
        toBN(dec(5, 15)).add(redemptionAmount.mul(mv._1e18BN).div(totalDebt).div(toBN(2)))
          .mul(ETHDrawn).div(mv._1e18BN)
      ),//.sub(toBN(gasUsed * GAS_PRICE)), // substract gas used for troveManager.redeemCollateral from expected received ETH
      100000
    )
  })

  it("redeemCollateral(): a full redemption (leaving trove with 0 debt), closes the trove", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 SATO
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    const { netDebt: W_netDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: dec(10000, 18), extraParams: { from: whale } })

    const { netDebt: A_netDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const { netDebt: D_netDebt } = await openTrove({ ICR: toBN(dec(280, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: D } })
    const redemptionAmount = A_netDebt.add(B_netDebt).add(C_netDebt).add(toBN(dec(10, 18)))

    const A_balanceBefore = toBN(await web3.eth.getBalance(A))
    const B_balanceBefore = toBN(await web3.eth.getBalance(B))
    const C_balanceBefore = toBN(await web3.eth.getBalance(C))

    // whale redeems 360 LUSD.  Expect this to fully redeem A, B, C, and partially redeem D.
    await th.redeemCollateral(whale, contracts, redemptionAmount, GAS_PRICE)

    // Check A, B, C still active
    assert.isTrue((await troveManager.getTroveStatus(A)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(B)).eq(toBN('1')))
    assert.isTrue((await troveManager.getTroveStatus(C)).eq(toBN('1')))

    // Check D remains active
    assert.isTrue((await troveManager.getTroveStatus(D)).eq(toBN('1')))
  })

  it('redeemCollateral(): reverts if fee eats up all returned collateral', async () => {
    // --- SETUP ---
    const { debtAmount } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(1, 24), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

    const price = await priceFeed.getPrice()
    assert.equal(price, dec(200, 18))

    // --- TEST ---

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // keep redeeming until we get the base rate to the ceiling of 100%
    for (let i = 0; i < 2; i++) {

      // Don't pay for gas, as it makes it easier to calculate the received Ether
      await debtToken.approve(troveManager.address, debtAmount, {from : alice});
      const redemptionTx = await troveManager.redeemCollateral(
        debtAmount, th._100pct,
        {
          from: alice,
          gasPrice: GAS_PRICE
        }
      )
      await borrowerOperations.closeTrove({ from: bob })

      await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })
	  
      let _adjustColl = debtAmount.mul(mv._1e18BN).div(price);
      await collateralToken.approve(borrowerOperations.address, mv._1Be18BN, {from : alice});
      await collateralToken.deposit({from : alice, value: _adjustColl });
      await borrowerOperations.adjustTrove(th._100pct, _adjustColl, true, debtAmount, true, { from: alice, value: 0 })
    }

    await assertRevert(
      troveManager.redeemCollateral(
        debtAmount, th._100pct,
        {
          from: alice,
          gasPrice: GAS_PRICE
        }
      ),
      'TroveManager: Fee would eat up all returned collateral'
    )
  })

  it("getPendingLUSDDebtReward(): Returns 0 if there is no pending LUSDDebt reward", async () => {
    // Make some troves
    const { totalDebt } = await openTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: dec(100, 18), extraParams: { from: defaulter_1 } })

    await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })

    await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: totalDebt, extraParams: { from: whale } })
    await stabilityPool.provideToSP(totalDebt, ZERO_ADDRESS, { from: whale })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    await troveManager.liquidate(defaulter_1)

    // Confirm defaulter_1 liquidated
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))

    // Confirm there are no pending rewards from liquidation
    const current_L_LUSDDebt = await troveManager.L_LUSDDebt()
    assert.equal(current_L_LUSDDebt, 0)

    const carolSnapshot_L_LUSDDebt = (await troveManager.rewardSnapshots(carol))[1]
    assert.equal(carolSnapshot_L_LUSDDebt, 0)

    const carol_PendingLUSDDebtReward = await troveManager.getPendingLUSDDebtReward(carol)
    assert.equal(carol_PendingLUSDDebtReward, 0)
  })

  it("getPendingETHReward(): Returns 0 if there is no pending ETH reward", async () => {
    // make some troves
    const { totalDebt } = await openTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: dec(100, 18), extraParams: { from: defaulter_1 } })

    await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })

    await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: totalDebt, extraParams: { from: whale } })
    await stabilityPool.provideToSP(totalDebt, ZERO_ADDRESS, { from: whale })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    await troveManager.liquidate(defaulter_1)

    // Confirm defaulter_1 liquidated
    assert.isFalse((await troveManager.getTroveStatus(defaulter_1)).eq(toBN('1')))

    // Confirm there are no pending rewards from liquidation
    const current_L_ETH = await troveManager.L_ETH()
    assert.equal(current_L_ETH, 0)

    const carolSnapshot_L_ETH = (await troveManager.rewardSnapshots(carol))[0]
    assert.equal(carolSnapshot_L_ETH, 0)

    const carol_PendingETHReward = await troveManager.getPendingETHReward(carol)
    assert.equal(carol_PendingETHReward, 0)
  })

  // --- computeICR ---

  it("computeICR(): Returns 0 if trove's coll is worth 0", async () => {
    const price = 0
    const coll = dec(1, 'ether')
    const debt = dec(100, 18)

    const ICR = (await troveManager.computeICR(coll, debt, price)).toString()

    assert.equal(ICR, 0)
  })

  it("computeICR(): Returns 2^256-1 for ETH:USD = 100, coll = 1 ETH, debt = 100 LUSD", async () => {
    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = dec(100, 18)

    const ICR = (await troveManager.computeICR(coll, debt, price)).toString()

    assert.equal(ICR, dec(1, 18))
  })

  it("computeICR(): returns correct ICR for ETH:USD = 100, coll = 200 ETH, debt = 30 LUSD", async () => {
    const price = dec(100, 18)
    const coll = dec(200, 'ether')
    const debt = dec(30, 18)

    const ICR = (await troveManager.computeICR(coll, debt, price)).toString()

    assert.isAtMost(th.getDifference(ICR, '666666666666666666666'), 1000)
  })

  it("computeICR(): returns correct ICR for ETH:USD = 250, coll = 1350 ETH, debt = 127 LUSD", async () => {
    const price = '250000000000000000000'
    const coll = '1350000000000000000000'
    const debt = '127000000000000000000'

    const ICR = (await troveManager.computeICR(coll, debt, price))

    assert.isAtMost(th.getDifference(ICR, '2657480314960630000000'), 1000000)
  })

  it("computeICR(): returns correct ICR for ETH:USD = 100, coll = 1 ETH, debt = 54321 LUSD", async () => {
    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = '54321000000000000000000'

    const ICR = (await troveManager.computeICR(coll, debt, price)).toString()

    assert.isAtMost(th.getDifference(ICR, '1840908672520756'), 1000)
  })


  it("computeICR(): Returns 2^256-1 if trove has non-zero coll and zero debt", async () => {
    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = 0

    const ICR = web3.utils.toHex(await troveManager.computeICR(coll, debt, price))
    const maxBytes32 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    assert.equal(ICR, maxBytes32)
  })

  // --- checkRecoveryMode ---

  //TCR < 150%
  it("checkRecoveryMode(): Returns true when TCR < 150%", async () => {
    await priceFeed.setPrice(dec(100, 18))

    await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

    await priceFeed.setPrice('79999999999999999999')

    const TCR = (await th.getTCR(contracts))

    assert.isTrue(TCR.lte(toBN('1300000000000000000')))

    assert.isTrue(await th.checkRecoveryMode(contracts))
  })

  // TCR == 150%
  it("checkRecoveryMode(): Returns false when TCR == 150%", async () => {
    await priceFeed.setPrice(dec(100, 18))

    await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

    const TCR = (await th.getTCR(contracts))

    assert.equal(TCR, '1500000000000000000')

    assert.isFalse(await th.checkRecoveryMode(contracts))
  })

  // > 150%
  it("checkRecoveryMode(): Returns false when TCR > 150%", async () => {
    await priceFeed.setPrice(dec(100, 18))

    await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

    await priceFeed.setPrice('100000000000000000001')

    const TCR = (await th.getTCR(contracts))

    assert.isTrue(TCR.gte(toBN('1500000000000000000')))

    assert.isFalse(await th.checkRecoveryMode(contracts))
  })

  // check 0
  it("checkRecoveryMode(): Returns false when TCR == 0", async () => {
    await priceFeed.setPrice(dec(100, 18))

    await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

    await priceFeed.setPrice(0)

    const TCR = (await th.getTCR(contracts)).toString()

    assert.equal(TCR, 0)

    assert.isTrue(await th.checkRecoveryMode(contracts))
  })

  // --- Getters ---

  it("getTroveStake(): Returns stake", async () => {
    const { collateral: A_coll } = await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: A } })
    const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: B } })

    const A_Stake = await troveManager.getTroveStake(A)
    const B_Stake = await troveManager.getTroveStake(B)

    assert.equal(A_Stake, A_coll.toString())
    assert.equal(B_Stake, B_coll.toString())
	
    await debtToken.transfer(A, await debtToken.balanceOf(B), {from: B})
    let _totalSystemCollBefore = await troveManager.getEntireSystemColl()
    let _totalStakesBefore = await troveManager.totalStakes()
    await borrowerOperations.closeTrove({from: A});
    let _totalStakesAfter = await troveManager.totalStakes()
    let _totalSystemCollAfter = await troveManager.getEntireSystemColl()
    let _totalStakesChange = _totalStakesBefore.sub(_totalStakesAfter)
    let _totalStakesChangePercentage = _totalStakesChange.mul(mv._1e18BN).div(_totalStakesBefore)
    let _totalSystemCollChange = _totalSystemCollBefore.sub(_totalSystemCollAfter)
    let _totalSystemCollChangePercentage = _totalSystemCollChange.mul(mv._1e18BN).div(_totalSystemCollBefore)
    assert.isTrue(_totalStakesAfter.eq(_totalStakesBefore.sub(A_Stake)));
    console.log('_totalStakesChangePercentage=' + _totalStakesChangePercentage + ',_totalSystemCollChangePercentage=' + _totalSystemCollChangePercentage);
    assert.isTrue(_totalStakesChangePercentage.eq(_totalSystemCollChangePercentage));
  })

  it("getTroveColl(): Returns coll", async () => {
    const { collateral: A_coll } = await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: A } })
    const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: B } })

    assert.equal(await troveManager.getTroveColl(A), A_coll.toString())
    assert.equal(await troveManager.getTroveColl(B), B_coll.toString())
  })

  it("getTroveDebt(): Returns debt", async () => {
    const { totalDebt: totalDebtA } = await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: A } })
    const { totalDebt: totalDebtB } = await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: B } })

    const A_Debt = await troveManager.getTroveDebt(A)
    const B_Debt = await troveManager.getTroveDebt(B)

    // Expect debt = requested + 0.5% fee + 50 (due to gas comp)

    assert.equal(A_Debt, totalDebtA.toString())
    assert.equal(B_Debt, totalDebtB.toString())
  })

  it("getTroveStatus(): Returns status", async () => {
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(150, 16)), extraLUSDAmount: B_totalDebt, extraParams: { from: A } })

    // to be able to repay:
    await debtToken.transfer(B, B_totalDebt, { from: A })
    await borrowerOperations.closeTrove({from: B})

    const A_Status = await troveManager.getTroveStatus(A)
    const B_Status = await troveManager.getTroveStatus(B)
    const C_Status = await troveManager.getTroveStatus(C)

    assert.equal(A_Status, '1')  // active
    assert.equal(B_Status, '2')  // closed by user
    assert.equal(C_Status, '0')  // non-existent
  })

  it("hasPendingRewards(): Returns false it trove is not active", async () => {
    assert.isFalse(await troveManager.hasPendingRewards(alice))
  })
})

contract('Reset chain state', async accounts => { })


const deploymentHelpers = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const TroveManagerTester = artifacts.require("./TroveManagerTester")
const BTUSDToken = artifacts.require("./BTUSDToken.sol")

const th  = testHelpers.TestHelper
const dec = th.dec
const toBN = th.toBN

contract('Pool Manager: Sum-Product rounding errors', async accounts => {

  const whale = accounts[0]

  const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  let contracts

  let priceFeed
  let debtToken
  let stabilityPool
  let troveManager
  let borrowerOperations
	
  const ZERO_ADDRESS = th.ZERO_ADDRESS
  const openTrove = async (params) => th.openTrove(contracts, params)

  beforeEach(async () => {    
    contracts = await deploymentHelpers.deployLiquityCore()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.debtToken = await BTUSDToken.new(
      contracts.troveManager.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address
    )
    const SATOContracts = await deploymentHelpers.deploySATOContracts(bountyAddress, lpRewardsAddress, multisig)

    priceFeed = contracts.priceFeedTestnet
    debtToken = contracts.debtToken
    troveManager = contracts.troveManager
    stabilityPool = contracts.stabilityPool
    borrowerOperations = contracts.borrowerOperations

    await deploymentHelpers.connectCoreContracts(contracts, SATOContracts)
    await deploymentHelpers.connectSATOContracts(SATOContracts)
    await deploymentHelpers.connectSATOContractsToCore(SATOContracts, contracts)
  })

  // skipped to not slow down CI
  it("Rounding errors: 100 deposits of 100LUSD into SP, then 200 liquidations of 49LUSD", async () => {
    const owner = accounts[0]
    const depositors = accounts.slice(1, 101)
    const defaulters = accounts.slice(101, 301)

    for (let account of depositors) {
      await openTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: toBN(dec(10000, 18)), extraParams: { from: account } })
      await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: account })
    }

    // Defaulter opens trove with 200% ICR
    for (let defaulter of defaulters) {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter } })
    }
    const price = await priceFeed.getPrice()

    // price drops by 50%: defaulter ICR falls to 100%
    await priceFeed.setPrice(dec(105, 18));

    // Defaulters liquidated
    for (let defaulter of defaulters) {
      await troveManager.liquidate(defaulter, { from: owner });
    }

    const SP_TotalDeposits = await stabilityPool.getTotalDebtDeposits()
    const SP_ETH = await stabilityPool.getETH()
    const compoundedDeposit = await stabilityPool.getCompoundedDebtDeposit(depositors[0])
    const ETH_Gain = await stabilityPool.getDepositorETHGain(depositors[0])

    // Check depostiors receive their share without too much error
    assert.isAtMost(th.getDifference(SP_TotalDeposits.div(th.toBN(depositors.length)), compoundedDeposit), 100000)
    assert.isAtMost(th.getDifference(SP_ETH.div(th.toBN(depositors.length)), ETH_Gain), 100000)
  })
})

contract('Reset chain state', async accounts => { })

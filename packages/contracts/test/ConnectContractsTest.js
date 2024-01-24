const deploymentHelper = require("../utils/deploymentHelpers.js")

contract('Deployment script - Sets correct contract addresses dependencies after deployment', async accounts => {
  const [owner] = accounts;

  const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)
  
  let priceFeed
  let debtToken
  let troveManager
  let activePool
  let stabilityPool
  let defaultPool
  let functionCaller
  let borrowerOperations
  let satoStaking
  let satoToken
  let communityIssuance
  let lockupContractFactory

  before(async () => {
    const coreContracts = await deploymentHelper.deployLiquityCore()
    const SATOContracts = await deploymentHelper.deploySATOContracts(bountyAddress, lpRewardsAddress, multisig)

    priceFeed = coreContracts.priceFeedTestnet
    debtToken = coreContracts.debtToken
    troveManager = coreContracts.troveManager
    activePool = coreContracts.activePool
    stabilityPool = coreContracts.stabilityPool
    defaultPool = coreContracts.defaultPool
    functionCaller = coreContracts.functionCaller
    borrowerOperations = coreContracts.borrowerOperations

    satoStaking = SATOContracts.satoStaking
    satoToken = SATOContracts.satoToken
    communityIssuance = SATOContracts.communityIssuance
    lockupContractFactory = SATOContracts.lockupContractFactory

    await deploymentHelper.connectSATOContracts(SATOContracts)
    await deploymentHelper.connectCoreContracts(coreContracts, SATOContracts)
    await deploymentHelper.connectSATOContractsToCore(SATOContracts, coreContracts)
  })

  it('Sets the correct PriceFeed address in TroveManager', async () => {
    const priceFeedAddress = priceFeed.address

    const recordedPriceFeedAddress = await troveManager.priceFeed()

    assert.equal(priceFeedAddress, recordedPriceFeedAddress)
  })

  it('Sets the correct BTUSDToken address in TroveManager', async () => {
    const debtTokenAddress = debtToken.address

    const recordedDebtTokenAddress = await troveManager.debtToken()

    assert.equal(debtTokenAddress, recordedDebtTokenAddress)
  })

  it('Sets the correct BorrowerOperations address in TroveManager', async () => {
    const borrowerOperationsAddress = borrowerOperations.address

    const recordedBorrowerOperationsAddress = await troveManager.borrowerOperationsAddress()

    assert.equal(borrowerOperationsAddress, recordedBorrowerOperationsAddress)
  })

  // ActivePool in TroveM
  it('Sets the correct ActivePool address in TroveManager', async () => {
    const activePoolAddress = activePool.address

    const recordedActivePoolAddresss = await troveManager.activePool()

    assert.equal(activePoolAddress, recordedActivePoolAddresss)
  })

  // DefaultPool in TroveM
  it('Sets the correct DefaultPool address in TroveManager', async () => {
    const defaultPoolAddress = defaultPool.address

    const recordedDefaultPoolAddresss = await troveManager.defaultPool()

    assert.equal(defaultPoolAddress, recordedDefaultPoolAddresss)
  })

  // StabilityPool in TroveM
  it('Sets the correct StabilityPool address in TroveManager', async () => {
    const stabilityPoolAddress = stabilityPool.address

    const recordedStabilityPoolAddresss = await troveManager.stabilityPool()

    assert.equal(stabilityPoolAddress, recordedStabilityPoolAddresss)
  })

  // SATO Staking in TroveM
  it('Sets the correct SATOStaking address in TroveManager', async () => {
    const satoStakingAddress = satoStaking.address

    const recordedSATOStakingAddress = await troveManager.satoStaking()
    assert.equal(satoStakingAddress, recordedSATOStakingAddress)
  })

  // Active Pool

  it('Sets the correct StabilityPool address in ActivePool', async () => {
    const stabilityPoolAddress = stabilityPool.address

    const recordedStabilityPoolAddress = await activePool.stabilityPoolAddress()

    assert.equal(stabilityPoolAddress, recordedStabilityPoolAddress)
  })

  it('Sets the correct DefaultPool address in ActivePool', async () => {
    const defaultPoolAddress = defaultPool.address

    const recordedDefaultPoolAddress = await activePool.defaultPoolAddress()

    assert.equal(defaultPoolAddress, recordedDefaultPoolAddress)
  })

  it('Sets the correct BorrowerOperations address in ActivePool', async () => {
    const borrowerOperationsAddress = borrowerOperations.address

    const recordedBorrowerOperationsAddress = await activePool.borrowerOperationsAddress()

    assert.equal(borrowerOperationsAddress, recordedBorrowerOperationsAddress)
  })

  it('Sets the correct TroveManager address in ActivePool', async () => {
    const troveManagerAddress = troveManager.address

    const recordedTroveManagerAddress = await activePool.troveManagerAddress()
    assert.equal(troveManagerAddress, recordedTroveManagerAddress)
  })

  // Stability Pool

  it('Sets the correct ActivePool address in StabilityPool', async () => {
    const activePoolAddress = activePool.address

    const recordedActivePoolAddress = await stabilityPool.activePool()
    assert.equal(activePoolAddress, recordedActivePoolAddress)
  })

  it('Sets the correct BorrowerOperations address in StabilityPool', async () => {
    const borrowerOperationsAddress = borrowerOperations.address

    const recordedBorrowerOperationsAddress = await stabilityPool.borrowerOperations()

    assert.equal(borrowerOperationsAddress, recordedBorrowerOperationsAddress)
  })

  it('Sets the correct BTUSDToken address in StabilityPool', async () => {
    const debtTokenAddress = debtToken.address

    const recordedDebtTokenAddress = await stabilityPool.debtToken()

    assert.equal(debtTokenAddress, recordedDebtTokenAddress)
  })

  it('Sets the correct TroveManager address in StabilityPool', async () => {
    const troveManagerAddress = troveManager.address

    const recordedTroveManagerAddress = await stabilityPool.troveManager()
    assert.equal(troveManagerAddress, recordedTroveManagerAddress)
  })

  // Default Pool

  it('Sets the correct TroveManager address in DefaultPool', async () => {
    const troveManagerAddress = troveManager.address

    const recordedTroveManagerAddress = await defaultPool.troveManagerAddress()
    assert.equal(troveManagerAddress, recordedTroveManagerAddress)
  })

  it('Sets the correct ActivePool address in DefaultPool', async () => {
    const activePoolAddress = activePool.address

    const recordedActivePoolAddress = await defaultPool.activePoolAddress()
    assert.equal(activePoolAddress, recordedActivePoolAddress)
  })

  //--- BorrowerOperations ---

  // TroveManager in BO
  it('Sets the correct TroveManager address in BorrowerOperations', async () => {
    const troveManagerAddress = troveManager.address

    const recordedTroveManagerAddress = await borrowerOperations.troveManager()
    assert.equal(troveManagerAddress, recordedTroveManagerAddress)
  })

  // setPriceFeed in BO
  it('Sets the correct PriceFeed address in BorrowerOperations', async () => {
    const priceFeedAddress = priceFeed.address

    const recordedPriceFeedAddress = await borrowerOperations.priceFeed()
    assert.equal(priceFeedAddress, recordedPriceFeedAddress)
  })

  // setActivePool in BO
  it('Sets the correct ActivePool address in BorrowerOperations', async () => {
    const activePoolAddress = activePool.address

    const recordedActivePoolAddress = await borrowerOperations.activePool()
    assert.equal(activePoolAddress, recordedActivePoolAddress)
  })

  // setDefaultPool in BO
  it('Sets the correct DefaultPool address in BorrowerOperations', async () => {
    const defaultPoolAddress = defaultPool.address

    const recordedDefaultPoolAddress = await borrowerOperations.defaultPool()
    assert.equal(defaultPoolAddress, recordedDefaultPoolAddress)
  })

  // SATO Staking in BO
  it('Sets the correct SATOStaking address in BorrowerOperations', async () => {
    const satoStakingAddress = satoStaking.address

    const recordedSATOStakingAddress = await borrowerOperations.satoStakingAddress()
    assert.equal(satoStakingAddress, recordedSATOStakingAddress)
  })


  // --- SATO Staking ---

  // Sets SATOToken in SATOStaking
  it('Sets the correct SATOToken address in SATOStaking', async () => {
    const satoTokenAddress = satoToken.address

    const recordedSATOTokenAddress = await satoStaking.satoToken()
    assert.equal(satoTokenAddress, recordedSATOTokenAddress)
  })

  // Sets ActivePool in SATOStaking
  it('Sets the correct ActivePool address in SATOStaking', async () => {
    const activePoolAddress = activePool.address

    const recordedActivePoolAddress = await satoStaking.activePoolAddress()
    assert.equal(activePoolAddress, recordedActivePoolAddress)
  })

  // Sets BTUSDToken in SATOStaking
  it('Sets the correct BTUSDToken address in SATOStaking', async () => {
    const debtTokenAddress = debtToken.address

    const recordedDebtTokenAddress = await satoStaking.debtToken()
    assert.equal(debtTokenAddress, recordedDebtTokenAddress)
  })

  // Sets TroveManager in SATOStaking
  it('Sets the correct ActivePool address in SATOStaking', async () => {
    const troveManagerAddress = troveManager.address

    const recordedTroveManagerAddress = await satoStaking.troveManagerAddress()
    assert.equal(troveManagerAddress, recordedTroveManagerAddress)
  })

  // Sets BorrowerOperations in SATOStaking
  it('Sets the correct BorrowerOperations address in SATOStaking', async () => {
    const borrowerOperationsAddress = borrowerOperations.address

    const recordedBorrowerOperationsAddress = await satoStaking.borrowerOperationsAddress()
    assert.equal(borrowerOperationsAddress, recordedBorrowerOperationsAddress)
  })

  // ---  SATOToken ---

  // Sets CI in SATOToken
  it('Sets the correct CommunityIssuance address in SATOToken', async () => {
    const communityIssuanceAddress = communityIssuance.address

    const recordedcommunityIssuanceAddress = await satoToken.communityIssuanceAddress()
    assert.equal(communityIssuanceAddress, recordedcommunityIssuanceAddress)
  })

  // Sets SATOStaking in SATOToken
  it('Sets the correct SATOStaking address in SATOToken', async () => {
    const satoStakingAddress = satoStaking.address

    const recordedSATOStakingAddress =  await satoToken.stakingAddress()
    assert.equal(satoStakingAddress, recordedSATOStakingAddress)
  })

  // Sets LCF in SATOToken
  it('Sets the correct LockupContractFactory address in SATOToken', async () => {
    const LCFAddress = lockupContractFactory.address

    const recordedLCFAddress =  await satoToken.lockupContractFactory()
    assert.equal(LCFAddress, recordedLCFAddress)
  })

  // --- LCF  ---

  // Sets SATOToken in LockupContractFactory
  it('Sets the correct SATOToken address in LockupContractFactory', async () => {
    const satoTokenAddress = satoToken.address

    const recordedSATOTokenAddress = await lockupContractFactory.satoTokenAddress()
    assert.equal(satoTokenAddress, recordedSATOTokenAddress)
  })

  // --- CI ---

  // Sets SATOToken in CommunityIssuance
  it('Sets the correct SATOToken address in CommunityIssuance', async () => {
    const satoTokenAddress = satoToken.address

    const recordedSATOTokenAddress = await communityIssuance.satoToken()
    assert.equal(satoTokenAddress, recordedSATOTokenAddress)
  })

  it('Sets the correct StabilityPool address in CommunityIssuance', async () => {
    const stabilityPoolAddress = stabilityPool.address

    const recordedStabilityPoolAddress = await communityIssuance.stabilityPoolAddress()
    assert.equal(stabilityPoolAddress, recordedStabilityPoolAddress)
  })
})

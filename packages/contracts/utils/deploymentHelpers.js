const TroveManager = artifacts.require("./TroveManager.sol")
const PriceFeedTestnet = artifacts.require("./PriceFeedTestnet.sol")
const BTUSDToken = artifacts.require("./BTUSDToken.sol")
const ActivePool = artifacts.require("./ActivePool.sol");
const DefaultPool = artifacts.require("./DefaultPool.sol");
const StabilityPool = artifacts.require("./StabilityPool.sol")
const CollSurplusPool = artifacts.require("./CollSurplusPool.sol")
const FunctionCaller = artifacts.require("./TestContracts/FunctionCaller.sol")
const BorrowerOperations = artifacts.require("./BorrowerOperations.sol")
const CollateralToken = artifacts.require("./CollateralTokenTester.sol")

const SATOStaking = artifacts.require("./SATOStaking.sol")
const SATOToken = artifacts.require("./SATOToken.sol")
const LockupContractFactory = artifacts.require("./LockupContractFactory.sol")
const CommunityIssuance = artifacts.require("./CommunityIssuance.sol")

const Unipool =  artifacts.require("./Unipool.sol")

const SATOTokenTester = artifacts.require("./SATOTokenTester.sol")
const CommunityIssuanceTester = artifacts.require("./CommunityIssuanceTester.sol")
const StabilityPoolTester = artifacts.require("./StabilityPoolTester.sol")
const ActivePoolTester = artifacts.require("./ActivePoolTester.sol")
const DefaultPoolTester = artifacts.require("./DefaultPoolTester.sol")
const LiquityMathTester = artifacts.require("./LiquityMathTester.sol")
const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol")
const TroveManagerTester = artifacts.require("./TroveManagerTester.sol")
const BTUSDTokenTester = artifacts.require("./BTUSDTokenTester.sol")

// Proxy scripts
const BorrowerOperationsScript = artifacts.require('BorrowerOperationsScript')
const BorrowerWrappersScript = artifacts.require('BorrowerWrappersScript')
const TroveManagerScript = artifacts.require('TroveManagerScript')
const StabilityPoolScript = artifacts.require('StabilityPoolScript')
const TokenScript = artifacts.require('TokenScript')
const SATOStakingScript = artifacts.require('SATOStakingScript')
const {
  buildUserProxies,
  BorrowerOperationsProxy,
  BorrowerWrappersProxy,
  TroveManagerProxy,
  StabilityPoolProxy,
  TokenProxy,
  SATOStakingProxy
} = require('../utils/proxyHelpers.js')

/* "Liquity core" consists of all contracts in the core Liquity system.

SATO contracts consist of only those contracts related to the SATO Token:

-the SATO token
-the Lockup factory and lockup contracts
-the SATOStaking contract
-the CommunityIssuance contract 
*/

const ZERO_ADDRESS = '0x' + '0'.repeat(40)
const maxBytes32 = '0x' + 'f'.repeat(64)

class DeploymentHelper {

  static async deployLiquityCore() {
    const cmdLineArgs = process.argv
    const frameworkPath = cmdLineArgs[1]
    // console.log(`Framework used:  ${frameworkPath}`)

    if (frameworkPath.includes("hardhat")) {
      return this.deployLiquityCoreHardhat()
    } else if (frameworkPath.includes("truffle")) {
      return this.deployLiquityCoreTruffle()
    }
  }

  static async deploySATOContracts(bountyAddress, lpRewardsAddress, multisigAddress) {
    const cmdLineArgs = process.argv
    const frameworkPath = cmdLineArgs[1]
    // console.log(`Framework used:  ${frameworkPath}`)

    if (frameworkPath.includes("hardhat")) {
      return this.deploySATOContractsHardhat(bountyAddress, lpRewardsAddress, multisigAddress)
    } else if (frameworkPath.includes("truffle")) {
      return this.deploySATOContractsTruffle(bountyAddress, lpRewardsAddress, multisigAddress)
    }
  }

  static async deployLiquityCoreHardhat() {
    const priceFeedTestnet = await PriceFeedTestnet.new()
    const troveManager = await TroveManager.new()
    const activePool = await ActivePool.new()
    const stabilityPool = await StabilityPool.new()
    const defaultPool = await DefaultPool.new()
    const collSurplusPool = await CollSurplusPool.new()
    const functionCaller = await FunctionCaller.new()
    const borrowerOperations = await BorrowerOperations.new()
    const debtToken = await BTUSDToken.new(
      troveManager.address,
      stabilityPool.address,
      borrowerOperations.address
    )
    const collateral = await CollateralToken.new()
    BTUSDToken.setAsDeployed(debtToken)
    DefaultPool.setAsDeployed(defaultPool)
    PriceFeedTestnet.setAsDeployed(priceFeedTestnet)
    TroveManager.setAsDeployed(troveManager)
    ActivePool.setAsDeployed(activePool)
    StabilityPool.setAsDeployed(stabilityPool)
    CollSurplusPool.setAsDeployed(collSurplusPool)
    FunctionCaller.setAsDeployed(functionCaller)
    BorrowerOperations.setAsDeployed(borrowerOperations)
    CollateralToken.setAsDeployed(collateral)

    const coreContracts = {
      priceFeedTestnet,
      debtToken,
      troveManager,
      activePool,
      stabilityPool,
      defaultPool,
      collSurplusPool,
      functionCaller,
      borrowerOperations,
      collateral    
    }
    return coreContracts
  }

  static async deployTesterContractsHardhat() {
    const testerContracts = {}

    // Contract without testers (yet)
    testerContracts.priceFeedTestnet = await PriceFeedTestnet.new()
    // Actual tester contracts
    testerContracts.communityIssuance = await CommunityIssuanceTester.new()
    testerContracts.activePool = await ActivePoolTester.new()
    testerContracts.defaultPool = await DefaultPoolTester.new()
    testerContracts.stabilityPool = await StabilityPoolTester.new()
    testerContracts.collSurplusPool = await CollSurplusPool.new()
    testerContracts.math = await LiquityMathTester.new()
    testerContracts.borrowerOperations = await BorrowerOperationsTester.new()
    testerContracts.troveManager = await TroveManagerTester.new()
    testerContracts.functionCaller = await FunctionCaller.new()
    testerContracts.debtToken = await BTUSDTokenTester.new(
      testerContracts.troveManager.address,
      testerContracts.stabilityPool.address,
      testerContracts.borrowerOperations.address
    )
    testerContracts.collateral = await CollateralToken.new()
    return testerContracts
  }

  static async deploySATOContractsHardhat(bountyAddress, lpRewardsAddress, multisigAddress) {
    const satoStaking = await SATOStaking.new()
    const lockupContractFactory = await LockupContractFactory.new()
    const communityIssuance = await CommunityIssuance.new()

    SATOStaking.setAsDeployed(satoStaking)
    LockupContractFactory.setAsDeployed(lockupContractFactory)
    CommunityIssuance.setAsDeployed(communityIssuance)

    // Deploy SATO Token, passing Community Issuance and Factory addresses to the constructor 
    const satoToken = await SATOToken.new(
      communityIssuance.address, 
      satoStaking.address,
      lockupContractFactory.address,
      bountyAddress,
      lpRewardsAddress,
      multisigAddress
    )
    SATOToken.setAsDeployed(satoToken)

    const SATOContracts = {
      satoStaking,
      lockupContractFactory,
      communityIssuance,
      satoToken
    }
    return SATOContracts
  }

  static async deploySATOTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisigAddress) {
    const satoStaking = await SATOStaking.new()
    const lockupContractFactory = await LockupContractFactory.new()
    const communityIssuance = await CommunityIssuanceTester.new()

    SATOStaking.setAsDeployed(satoStaking)
    LockupContractFactory.setAsDeployed(lockupContractFactory)
    CommunityIssuanceTester.setAsDeployed(communityIssuance)

    // Deploy SATO Token, passing Community Issuance and Factory addresses to the constructor 
    const satoToken = await SATOTokenTester.new(
      communityIssuance.address, 
      satoStaking.address,
      lockupContractFactory.address,
      bountyAddress,
      lpRewardsAddress,
      multisigAddress
    )
    SATOTokenTester.setAsDeployed(satoToken)

    const SATOContracts = {
      satoStaking,
      lockupContractFactory,
      communityIssuance,
      satoToken
    }
    return SATOContracts
  }

  static async deployLiquityCoreTruffle() {
    const priceFeedTestnet = await PriceFeedTestnet.new()
    const troveManager = await TroveManager.new()
    const activePool = await ActivePool.new()
    const stabilityPool = await StabilityPool.new()
    const defaultPool = await DefaultPool.new()
    const collSurplusPool = await CollSurplusPool.new()
    const functionCaller = await FunctionCaller.new()
    const borrowerOperations = await BorrowerOperations.new()
    const debtToken = await BTUSDToken.new(
      troveManager.address,
      stabilityPool.address,
      borrowerOperations.address
    )
    const coreContracts = {
      priceFeedTestnet,
      debtToken,
      troveManager,
      activePool,
      stabilityPool,
      defaultPool,
      collSurplusPool,
      functionCaller,
      borrowerOperations
    }
    return coreContracts
  }

  static async deploySATOContractsTruffle(bountyAddress, lpRewardsAddress, multisigAddress) {
    const satoStaking = await satoStaking.new()
    const lockupContractFactory = await LockupContractFactory.new()
    const communityIssuance = await CommunityIssuance.new()

    /* Deploy SATO Token, passing Community Issuance, SATOStaking, and Factory addresses 
    to the constructor  */
    const satoToken = await SATOToken.new(
      communityIssuance.address, 
      satoStaking.address,
      lockupContractFactory.address,
      bountyAddress,
      lpRewardsAddress, 
      multisigAddress
    )

    const SATOContracts = {
      satoStaking,
      lockupContractFactory,
      communityIssuance,
      satoToken
    }
    return SATOContracts
  }

  static async deployDebtToken(contracts) {
    contracts.debtToken = await BTUSDToken.new(
      contracts.troveManager.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address
    )
    return contracts
  }

  static async deployDebtTokenTester(contracts) {
    contracts.debtToken = await BTUSDTokenTester.new(
      contracts.troveManager.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address
    )
    return contracts
  }

  static async deployProxyScripts(contracts, SATOContracts, owner, users) {
    const proxies = await buildUserProxies(users)

    const borrowerWrappersScript = await BorrowerWrappersScript.new(
      contracts.borrowerOperations.address,
      contracts.troveManager.address,
      SATOContracts.satoStaking.address,
      contracts.collateral.address
    )
    contracts.borrowerWrappers = new BorrowerWrappersProxy(owner, proxies, borrowerWrappersScript.address)

    const borrowerOperationsScript = await BorrowerOperationsScript.new(contracts.borrowerOperations.address)
    contracts.borrowerOperations = new BorrowerOperationsProxy(owner, proxies, borrowerOperationsScript.address, contracts.borrowerOperations)

    const troveManagerScript = await TroveManagerScript.new(contracts.troveManager.address)
    contracts.troveManager = new TroveManagerProxy(owner, proxies, troveManagerScript.address, contracts.troveManager)

    const stabilityPoolScript = await StabilityPoolScript.new(contracts.stabilityPool.address)
    contracts.stabilityPool = new StabilityPoolProxy(owner, proxies, stabilityPoolScript.address, contracts.stabilityPool)

    const debtTokenScript = await TokenScript.new(contracts.debtToken.address)
    contracts.debtToken = new TokenProxy(owner, proxies, debtTokenScript.address, contracts.debtToken)

    const satoTokenScript = await TokenScript.new(SATOContracts.satoToken.address)
    SATOContracts.satoToken = new TokenProxy(owner, proxies, satoTokenScript.address, SATOContracts.satoToken)

    const satoStakingScript = await SATOStakingScript.new(SATOContracts.satoStaking.address)
    SATOContracts.satoStaking = new SATOStakingProxy(owner, proxies, satoStakingScript.address, SATOContracts.satoStaking)
  }

  // Connect contracts to their dependencies
  static async connectCoreContracts(contracts, SATOContracts) {

    // set contract addresses in the FunctionCaller 
    await contracts.functionCaller.setTroveManagerAddress(contracts.troveManager.address)

    // set contracts in the Trove Manager
    await contracts.troveManager.setAddresses(
      contracts.borrowerOperations.address,
      contracts.activePool.address,
      contracts.defaultPool.address,
      contracts.stabilityPool.address,
      contracts.collSurplusPool.address,
      contracts.priceFeedTestnet.address,
      contracts.debtToken.address,
      SATOContracts.satoToken.address,
      SATOContracts.satoStaking.address,
      contracts.collateral.address
    )

    // set contracts in BorrowerOperations 
    await contracts.borrowerOperations.setAddresses(
      contracts.troveManager.address,
      contracts.activePool.address,
      contracts.defaultPool.address,
      contracts.stabilityPool.address,
      contracts.collSurplusPool.address,
      contracts.priceFeedTestnet.address,
      contracts.debtToken.address,
      SATOContracts.satoStaking.address,
      contracts.collateral.address
    )

    // set contracts in the Pools
    await contracts.stabilityPool.setAddresses(
      contracts.borrowerOperations.address,
      contracts.troveManager.address,
      contracts.activePool.address,
      contracts.debtToken.address,
      contracts.priceFeedTestnet.address,
      SATOContracts.communityIssuance.address,
      contracts.collateral.address
    )

    await contracts.activePool.setAddresses(
      contracts.borrowerOperations.address,
      contracts.troveManager.address,
      contracts.stabilityPool.address,
      contracts.defaultPool.address,
      contracts.collSurplusPool.address,
      contracts.collateral.address,
      contracts.debtToken.address,
      SATOContracts.satoStaking.address
    )

    await contracts.defaultPool.setAddresses(
      contracts.troveManager.address,
      contracts.activePool.address,
      contracts.collateral.address
    )

    await contracts.collSurplusPool.setAddresses(
      contracts.borrowerOperations.address,
      contracts.troveManager.address,
      contracts.activePool.address,
      contracts.collateral.address
    )
  }

  static async connectSATOContracts(SATOContracts) {
    // Set SATOToken address in LCF
    await SATOContracts.lockupContractFactory.setSATOTokenAddress(SATOContracts.satoToken.address)
  }

  static async connectSATOContractsToCore(SATOContracts, coreContracts) {
    await SATOContracts.satoStaking.setAddresses(
      SATOContracts.satoToken.address,
      coreContracts.debtToken.address,
      coreContracts.troveManager.address, 
      coreContracts.borrowerOperations.address,
      coreContracts.activePool.address,
      coreContracts.collateral.address
    )
  
    await SATOContracts.communityIssuance.setAddresses(
      SATOContracts.satoToken.address,
      coreContracts.stabilityPool.address
    )
  }

  static async connectUnipool(uniPool, SATOContracts, uniswapPairAddr, duration) {
    await uniPool.setParams(SATOContracts.satoToken.address, uniswapPairAddr, duration)
  }
}
module.exports = DeploymentHelper

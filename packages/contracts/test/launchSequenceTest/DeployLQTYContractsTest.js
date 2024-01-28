const deploymentHelper = require("../../utils/deploymentHelpers.js")
const testHelpers = require("../../utils/testHelpers.js")
const CommunityIssuance = artifacts.require("./CommunityIssuance.sol")


const th = testHelpers.TestHelper
const timeValues = testHelpers.TimeValues
const assertRevert = th.assertRevert
const toBN = th.toBN
const dec = th.dec

contract('Deploying the SATO contracts: LCF, CI, SATOStaking, and SATOToken ', async accounts => {
  const [liquityAG, A, B] = accounts;
  const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  let SATOContracts

  const oneMillion = toBN(1000000)
  const digits = toBN(1e18)
  const thirtyTwo = toBN(32)
  const expectedCISupplyCap = thirtyTwo.mul(oneMillion).mul(digits)

  beforeEach(async () => {
    // Deploy all contracts from the first account
    SATOContracts = await deploymentHelper.deploySATOContracts(bountyAddress, lpRewardsAddress, multisig)
    await deploymentHelper.connectSATOContracts(SATOContracts)

    satoStaking = SATOContracts.satoStaking
    satoToken = SATOContracts.satoToken
    communityIssuance = SATOContracts.communityIssuance
    lockupContractFactory = SATOContracts.lockupContractFactory

    //SATO Staking and CommunityIssuance have not yet had their setters called, so are not yet
    // connected to the rest of the system
  })


  describe('CommunityIssuance deployment', async accounts => {
    it("Stores the deployer's address", async () => {
      const storedDeployerAddress = await communityIssuance.owner()

      assert.equal(liquityAG, storedDeployerAddress)
    })
  })

  describe('SATOStaking deployment', async accounts => {
    it("Stores the deployer's address", async () => {
      const storedDeployerAddress = await satoStaking.owner()

      assert.equal(liquityAG, storedDeployerAddress)
    })
  })

  describe('SATOToken deployment', async accounts => {
    it("Stores the multisig's address", async () => {
      const storedMultisigAddress = await satoToken.multisigAddress()

      assert.equal(multisig, storedMultisigAddress)
    })

    it("Stores the CommunityIssuance address", async () => {
      const storedCIAddress = await satoToken.communityIssuanceAddress()

      assert.equal(communityIssuance.address, storedCIAddress)
    })

    it("Stores the LockupContractFactory address", async () => {
      const storedLCFAddress = await satoToken.lockupContractFactory()

      assert.equal(lockupContractFactory.address, storedLCFAddress)
    })

    it("Mints the correct SATO amount to the CommunityIssuance contract address: 32 million", async () => {
      const communitySATOEntitlement = await satoToken.balanceOf(communityIssuance.address)
      // 32 million as 18-digit decimal
      const _32Million = dec(32, 24)

      assert.equal(communitySATOEntitlement, _32Million)
    })

    it("Mints the correct SATO amount to the bountyAddress EOA: 2 million", async () => {
      const bountyAddressBal = await satoToken.balanceOf(bountyAddress)
      // 2 million as 18-digit decimal
      const _2Million = dec(2, 24)

      assert.equal(bountyAddressBal, _2Million)
    })

    it("Mints the correct SATO amount to the lpRewardsAddress EOA: 1.33 million", async () => {
      const lpRewardsAddressBal = await satoToken.balanceOf(lpRewardsAddress)
      // 4 million as 18-digit decimal
      assert.equal(lpRewardsAddressBal, dec(4, 24))
    })
  })

  describe('Community Issuance deployment', async accounts => {
    it("Stores the deployer's address", async () => {

      const storedDeployerAddress = await communityIssuance.owner()

      assert.equal(storedDeployerAddress, liquityAG)
    })

    it("Has a supply cap of 32 million", async () => {
      const supplyCap = await communityIssuance.SATOSupplyCap()

      assert.isTrue(expectedCISupplyCap.eq(supplyCap))
    })

    it("Liquity AG can set addresses if CI's SATO balance is equal or greater than 32 million ", async () => {
      const SATOBalance = await satoToken.balanceOf(communityIssuance.address)
      assert.isTrue(SATOBalance.eq(expectedCISupplyCap))

      // Deploy core contracts, just to get the Stability Pool address
      const coreContracts = await deploymentHelper.deployLiquityCore()

      const tx = await communityIssuance.setAddresses(
        satoToken.address,
        coreContracts.stabilityPool.address,
        { from: liquityAG }
      );
      assert.isTrue(tx.receipt.status)
    })

    it("Liquity AG can't set addresses if CI's SATO balance is < 32 million ", async () => {
      const newCI = await CommunityIssuance.new()

      const SATOBalance = await satoToken.balanceOf(newCI.address)
      assert.equal(SATOBalance, '0')

      // Deploy core contracts, just to get the Stability Pool address
      const coreContracts = await deploymentHelper.deployLiquityCore()

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await satoToken.transfer(newCI.address, '1999999999999999999999999', {from: bountyAddress}) // 1e-18 less than CI expects (32 million)

      try {
        const tx = await newCI.setAddresses(
          satoToken.address,
          coreContracts.stabilityPool.address,
          { from: liquityAG }
        );
      
        // Check it gives the expected error message for a failed Solidity 'assert'
      } catch (err) {
        assert.include(err.message, "invalid opcode")
      }
    })
  })

  describe('Connecting SATOToken to LCF, CI and SATOStaking', async accounts => {
    it('sets the correct SATOToken address in SATOStaking', async () => {
      // Deploy core contracts and set the SATOToken address in the CI and SATOStaking
      const coreContracts = await deploymentHelper.deployLiquityCore()
      await deploymentHelper.connectSATOContractsToCore(SATOContracts, coreContracts)

      const satoTokenAddress = satoToken.address

      const recordedSATOTokenAddress = await satoStaking.satoToken()
      assert.equal(satoTokenAddress, recordedSATOTokenAddress)
    })

    it('sets the correct SATOToken address in LockupContractFactory', async () => {
      const satoTokenAddress = satoToken.address

      const recordedSATOTokenAddress = await lockupContractFactory.satoTokenAddress()
      assert.equal(satoTokenAddress, recordedSATOTokenAddress)
    })

    it('sets the correct SATOToken address in CommunityIssuance', async () => {
      // Deploy core contracts and set the SATOToken address in the CI and SATOStaking
      const coreContracts = await deploymentHelper.deployLiquityCore()
      await deploymentHelper.connectSATOContractsToCore(SATOContracts, coreContracts)

      const satoTokenAddress = satoToken.address

      const recordedSATOTokenAddress = await communityIssuance.satoToken()
      assert.equal(satoTokenAddress, recordedSATOTokenAddress)
    })
  })
})

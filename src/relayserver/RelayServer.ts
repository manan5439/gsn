import chalk from 'chalk'
import ow from 'ow'
import { EventData } from 'web3-eth-contract'
import { EventEmitter } from 'events'
import { PrefixedHexString } from 'ethereumjs-tx'
import { toBN, toHex } from 'web3-utils'

import { IRelayHubInstance } from '../../types/truffle-contracts'

import ContractInteractor, { TransactionRejectedByPaymaster } from '../relayclient/ContractInteractor'
import { IntString } from '../relayclient/types/Aliases'
import { RelayTransactionRequest, RelayTransactionRequestShape } from '../relayclient/types/RelayTransactionRequest'

import PingResponse from '../common/PingResponse'
import VersionsManager from '../common/VersionsManager'
import { AmountRequired } from '../common/AmountRequired'
import { LoggerInterface } from '../common/LoggerInterface'
import { defaultEnvironment } from '../common/Environments'
import { gsnRuntimeVersion } from '../common/Version'
import {
  address2topic,
  calculateTransactionMaxPossibleGas,
  decodeRevertReason,
  getLatestEventData,
  PaymasterGasLimits,
  randomInRange,
  sleep
} from '../common/Utils'

import { RegistrationManager } from './RegistrationManager'
import { SendTransactionDetails, TransactionManager } from './TransactionManager'
import { ServerAction } from './StoredTransaction'
import { TxStoreManager } from './TxStoreManager'
import { configureServer, ServerConfigParams, ServerDependencies } from './ServerConfigParams'

import Timeout = NodeJS.Timeout

const GAS_RESERVE = 100000

export class RelayServer extends EventEmitter {
  readonly logger: LoggerInterface
  lastScannedBlock = 0
  lastRefreshBlock = 0
  ready = false
  lastSuccessfulRounds = Number.MAX_SAFE_INTEGER
  readonly managerAddress: PrefixedHexString
  readonly workerAddress: PrefixedHexString
  gasPrice: number = 0
  _workerSemaphoreOn = false
  alerted = false
  alertedBlock: number = 0
  private initialized = false
  readonly contractInteractor: ContractInteractor
  private readonly versionManager: VersionsManager
  private workerTask?: Timeout
  config: ServerConfigParams
  transactionManager: TransactionManager
  txStoreManager: TxStoreManager

  lastMinedActiveTransaction?: EventData

  registrationManager!: RegistrationManager
  chainId!: number
  networkId!: number
  relayHubContract!: IRelayHubInstance

  trustedPaymastersGasLimits: Map<String | undefined, PaymasterGasLimits> = new Map<String | undefined, PaymasterGasLimits>()

  workerBalanceRequired: AmountRequired

  constructor (config: Partial<ServerConfigParams>, dependencies: ServerDependencies) {
    super()
    this.logger = dependencies.logger
    this.versionManager = new VersionsManager(gsnRuntimeVersion)
    this.config = configureServer(config)
    this.contractInteractor = dependencies.contractInteractor
    this.txStoreManager = dependencies.txStoreManager
    this.transactionManager = new TransactionManager(dependencies, this.config)
    this.managerAddress = this.transactionManager.managerKeyManager.getAddress(0)
    this.workerAddress = this.transactionManager.workersKeyManager.getAddress(0)
    this.workerBalanceRequired = new AmountRequired('Worker Balance', toBN(this.config.workerMinBalance), this.logger)
    this.printServerAddresses()
    this.logger.warn(`RelayServer version', ${gsnRuntimeVersion}`)
    this.logger.info(`Using server configuration:\n ${JSON.stringify(this.config)}`)
  }

  printServerAddresses (): void {
    this.logger.info(`Server manager address  | ${this.managerAddress}`)
    this.logger.info(`Server worker  address  | ${this.workerAddress}`)
  }

  getMinGasPrice (): number {
    return this.gasPrice
  }

  pingHandler (paymaster?: string): PingResponse {
    return {
      relayWorkerAddress: this.workerAddress,
      relayManagerAddress: this.managerAddress,
      relayHubAddress: this.relayHubContract?.address ?? '',
      minGasPrice: this.getMinGasPrice().toString(),
      maxAcceptanceBudget: this._getPaymasterMaxAcceptanceBudget(paymaster),
      chainId: this.chainId.toString(),
      networkId: this.networkId.toString(),
      ready: this.isReady() ?? false,
      version: gsnRuntimeVersion
    }
  }

  validateInputTypes (req: RelayTransactionRequest): void {
    ow(req, ow.object.exactShape(RelayTransactionRequestShape))
  }

  validateInput (req: RelayTransactionRequest): void {
    // Check that the relayHub is the correct one
    if (req.metadata.relayHubAddress !== this.relayHubContract.address) {
      throw new Error(
        `Wrong hub address.\nRelay server's hub address: ${this.relayHubContract.address}, request's hub address: ${req.metadata.relayHubAddress}\n`)
    }

    // Check the relayWorker (todo: once migrated to multiple relays, check if exists)
    if (req.relayRequest.relayData.relayWorker.toLowerCase() !== this.workerAddress.toLowerCase()) {
      throw new Error(
        `Wrong worker address: ${req.relayRequest.relayData.relayWorker}\n`)
    }

    // Check that the gasPrice is initialized & acceptable
    if (this.gasPrice > parseInt(req.relayRequest.relayData.gasPrice)) {
      throw new Error(
        `Unacceptable gasPrice: relayServer's gasPrice:${this.gasPrice} request's gasPrice: ${req.relayRequest.relayData.gasPrice}`)
    }
  }

  validateFees (req: RelayTransactionRequest): void {
    // if trusted paymaster, we trust it to handle fees
    if (this._isTrustedPaymaster(req.relayRequest.relayData.paymaster)) {
      return
    }
    // Check that the fee is acceptable
    if (parseInt(req.relayRequest.relayData.pctRelayFee) < this.config.pctRelayFee) {
      throw new Error(`Unacceptable pctRelayFee: ${req.relayRequest.relayData.pctRelayFee} relayServer's pctRelayFee: ${this.config.pctRelayFee}`)
    }
    if (toBN(req.relayRequest.relayData.baseRelayFee).lt(toBN(this.config.baseRelayFee))) {
      throw new Error(`Unacceptable baseRelayFee: ${req.relayRequest.relayData.baseRelayFee} relayServer's baseRelayFee: ${this.config.baseRelayFee}`)
    }
  }

  async validateMaxNonce (relayMaxNonce: number): Promise<void> {
    // Check that max nonce is valid
    const nonce = await this.transactionManager.pollNonce(this.workerAddress)
    if (nonce > relayMaxNonce) {
      throw new Error(`Unacceptable relayMaxNonce: ${relayMaxNonce}. current nonce: ${nonce}`)
    }
  }

  async validatePaymasterGasLimits (req: RelayTransactionRequest): Promise<{
    maxPossibleGas: number
    acceptanceBudget: number
  }> {
    const paymaster = req.relayRequest.relayData.paymaster
    let gasLimits = this.trustedPaymastersGasLimits.get(paymaster)
    let acceptanceBudget: number
    if (gasLimits == null) {
      try {
        const paymasterContract = await this.contractInteractor._createPaymaster(paymaster)
        gasLimits = await paymasterContract.getGasLimits()
      } catch (e) {
        const error = e as Error
        let message = `unknown paymaster error: ${error.message}`
        if (error.message.includes('Returned values aren\'t valid, did it run Out of Gas?')) {
          message = `not a valid paymaster contract: ${paymaster}`
        } else if (error.message.includes('no code at address')) {
          message = `'non-existent paymaster contract: ${paymaster}`
        }
        throw new Error(message)
      }
      acceptanceBudget = this.config.maxAcceptanceBudget
      const paymasterAcceptanceBudget = parseInt(gasLimits.acceptanceBudget)
      if (paymasterAcceptanceBudget > acceptanceBudget) {
        if (!this._isTrustedPaymaster(paymaster)) {
          throw new Error(
            `paymaster acceptance budget too high. given: ${paymasterAcceptanceBudget} max allowed: ${this.config.maxAcceptanceBudget}`)
        }
        this.logger.debug(`Using trusted paymaster's higher than max acceptance budget: ${paymasterAcceptanceBudget}`)
        acceptanceBudget = paymasterAcceptanceBudget
      }
    } else {
      // its a trusted paymaster. just use its acceptance budget as-is
      acceptanceBudget = parseInt(gasLimits.acceptanceBudget)
    }

    const hubOverhead = (await this.relayHubContract.gasOverhead()).toNumber()
    const maxPossibleGas = GAS_RESERVE + calculateTransactionMaxPossibleGas({
      gasLimits,
      hubOverhead,
      relayCallGasLimit: req.relayRequest.request.gas
    })
    const maxCharge =
      await this.relayHubContract.calculateCharge(maxPossibleGas, req.relayRequest.relayData)
    const paymasterBalance = await this.relayHubContract.balanceOf(paymaster)

    if (paymasterBalance.lt(maxCharge)) {
      throw new Error(`paymaster balance too low: ${paymasterBalance.toString()}, maxCharge: ${maxCharge.toString()}`)
    }
    this.logger.debug(`paymaster balance: ${paymasterBalance.toString()}, maxCharge: ${maxCharge.toString()}`)
    this.logger.debug(`Estimated max charge of relayed tx: ${maxCharge.toString()}, GasLimit of relayed tx: ${maxPossibleGas}`)

    return {
      acceptanceBudget,
      maxPossibleGas
    }
  }

  async validateViewCallSucceeds (req: RelayTransactionRequest, acceptanceBudget: number, maxPossibleGas: number): Promise<void> {
    const method = this.relayHubContract.contract.methods.relayCall(
      acceptanceBudget, req.relayRequest, req.metadata.signature, req.metadata.approvalData, maxPossibleGas)
    let viewRelayCallRet: { paymasterAccepted: boolean, returnValue: string }
    try {
      viewRelayCallRet =
        await method.call({
          from: this.workerAddress,
          gasPrice: req.relayRequest.relayData.gasPrice,
          gasLimit: maxPossibleGas
        })
    } catch (e) {
      throw new Error(`relayCall reverted in server: ${(e as Error).message}`)
    }
    this.logger.debug(`Result for view-only relay call:
paymasterAccepted  | ${viewRelayCallRet.paymasterAccepted ? chalk.green('true') : chalk.red('false')}
returnValue        | ${viewRelayCallRet.returnValue}
`)
    if (!viewRelayCallRet.paymasterAccepted) {
      throw new Error(
        `Paymaster rejected in server: ${decodeRevertReason(viewRelayCallRet.returnValue)} req=${JSON.stringify(req, null, 2)}`)
    }
  }

  async createRelayTransaction (req: RelayTransactionRequest): Promise<PrefixedHexString> {
    this.logger.debug(`dump request params: ${JSON.stringify(req)}`)
    if (!this.isReady()) {
      throw new Error('relay not ready')
    }
    this.validateInputTypes(req)
    this.validateInput(req)
    this.validateFees(req)
    await this.validateMaxNonce(req.metadata.relayMaxNonce)

    // Call relayCall as a view function to see if we'll get paid for relaying this tx
    const { acceptanceBudget, maxPossibleGas } = await this.validatePaymasterGasLimits(req)
    await this.validateViewCallSucceeds(req, acceptanceBudget, maxPossibleGas)
    // Send relayed transaction
    this.logger.debug(`maxPossibleGas is: ${maxPossibleGas}`)

    const method = this.relayHubContract.contract.methods.relayCall(
      acceptanceBudget, req.relayRequest, req.metadata.signature, req.metadata.approvalData, maxPossibleGas)
    const currentBlock = await this.contractInteractor.getBlockNumber()
    const details: SendTransactionDetails =
      {
        signer: this.workerAddress,
        serverAction: ServerAction.RELAY_CALL,
        method,
        destination: req.metadata.relayHubAddress,
        gasLimit: maxPossibleGas,
        creationBlockNumber: currentBlock,
        gasPrice: req.relayRequest.relayData.gasPrice
      }
    const { signedTx } = await this.transactionManager.sendTransaction(details)
    // after sending a transaction is a good time to check the worker's balance, and replenish it.
    await this.replenishServer(0, currentBlock)
    if (this.alerted) {
      this.logger.error('Alerted state: slowing down traffic')
      await sleep(randomInRange(this.config.minAlertedDelayMS, this.config.maxAlertedDelayMS))
    }
    return signedTx
  }

  async intervalHandler (): Promise<void> {
    const now = Date.now()
    let workerTimeout: Timeout
    if (!this.config.devMode) {
      workerTimeout = setTimeout(() => {
        const timedOut = Date.now() - now
        this.logger.warn(chalk.bgRedBright(`Relay state: Timed-out after ${timedOut}`))

        this.lastSuccessfulRounds = 0
      }, this.config.readyTimeout)
    }

    return this.contractInteractor.getBlock('latest')
      .then(
        block => {
          if (block.number > this.lastScannedBlock) {
            return this._workerSemaphore.bind(this)(block.number)
          }
        })
      .catch((e) => {
        this.emit('error', e)
        const error = e as Error
        this.logger.error(`error in worker: ${error.message} ${error.stack}`)
        this.lastSuccessfulRounds = 0
      })
      .finally(() => {
        clearTimeout(workerTimeout)
      })
  }

  start (): void {
    this.logger.debug(`Started polling for new blocks every ${this.config.checkInterval}ms`)
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.workerTask = setInterval(this.intervalHandler.bind(this), this.config.checkInterval)
  }

  stop (): void {
    if (this.workerTask == null) {
      throw new Error('Server not started')
    }
    clearInterval(this.workerTask)
    this.logger.info('Successfully stopped polling!!')
  }

  async _workerSemaphore (blockNumber: number): Promise<void> {
    if (this._workerSemaphoreOn) {
      this.logger.warn('Different worker is not finished yet, skipping this block')
      return
    }
    this._workerSemaphoreOn = true

    await this._worker(blockNumber)
      .then((transactions) => {
        this.lastSuccessfulRounds++
        if (transactions.length !== 0) {
          this.logger.debug(`Done handling block #${blockNumber}. Created ${transactions.length} transactions.`)
        }
      })
      .finally(() => {
        this._workerSemaphoreOn = false
      })
  }

  fatal (message: string): void {
    this.logger.error('FATAL: ' + message)
    process.exit(1)
  }

  /***
   * initialize data from trusted paymasters.
   * "Trusted" paymasters means that:
   * - we trust their code not to alter the gas limits (getGasLimits returns constants)
   * - we trust preRelayedCall to be consistent: off-chain call and on-chain calls should either both succeed
   *    or both revert.
   * - given that, we agree to give the requested acceptanceBudget (since breaking one of the above two "invariants"
   *    is the only cases where the relayer will have to pay for this budget)
   *
   * @param paymasters list of trusted paymaster addresses
   */
  async _initTrustedPaymasters (paymasters: string[] = []): Promise<void> {
    this.trustedPaymastersGasLimits.clear()
    for (const paymasterAddress of paymasters) {
      const paymaster = await this.contractInteractor._createPaymaster(paymasterAddress)
      const gasLimits = await paymaster.getGasLimits().catch((e: Error) => {
        throw new Error(`not a valid paymaster address in trustedPaymasters list: ${paymasterAddress}: ${e.message}`)
      })
      this.trustedPaymastersGasLimits.set(paymasterAddress.toLowerCase(), gasLimits)
    }
  }

  _getPaymasterMaxAcceptanceBudget (paymaster?: string): IntString {
    const limits = this.trustedPaymastersGasLimits.get(paymaster?.toLocaleLowerCase())
    if (limits != null) {
      return limits.acceptanceBudget
    } else {
      return this.config.maxAcceptanceBudget.toString()
    }
  }

  async init (): Promise<void> {
    if (this.initialized) {
      throw new Error('_init was already called')
    }

    await this.transactionManager._init()
    await this._initTrustedPaymasters(this.config.trustedPaymasters)
    this.relayHubContract = await this.contractInteractor.relayHubInstance

    const relayHubAddress = this.relayHubContract.address
    const code = await this.contractInteractor.getCode(relayHubAddress)
    if (code.length < 10) {
      this.fatal(`No RelayHub deployed at address ${relayHubAddress}.`)
    }

    this.registrationManager = new RegistrationManager(
      this.contractInteractor,
      this.transactionManager,
      this.txStoreManager,
      this,
      this.logger,
      this.config,
      this.managerAddress,
      this.workerAddress
    )
    await this.registrationManager.init()

    this.chainId = await this.contractInteractor.getChainId()
    this.networkId = await this.contractInteractor.getNetworkId()
    if (this.config.devMode && (this.chainId < 1000 || this.networkId < 1000)) {
      this.logger.error('Don\'t use real network\'s chainId & networkId while in devMode.')
      process.exit(-1)
    }

    const latestBlock = await this.contractInteractor.getBlock('latest')
    this.logger.info(`Current network info:
chainId                 | ${this.chainId}
networkId               | ${this.networkId}
latestBlock             | ${latestBlock.number}
latestBlock timestamp   | ${latestBlock.timestamp}
`)
    this.initialized = true

    // Assume started server is not registered until _worker figures stuff out
    this.registrationManager.printNotRegisteredMessage()
  }

  async replenishServer (workerIndex: number, currentBlock: number): Promise<PrefixedHexString[]> {
    const transactionHashes: PrefixedHexString[] = []
    let managerEthBalance = await this.getManagerBalance()
    const managerHubBalance = await this.relayHubContract.balanceOf(this.managerAddress)
    this.workerBalanceRequired.currentValue = await this.getWorkerBalance(workerIndex)
    if (managerEthBalance.gte(toBN(this.config.managerTargetBalance.toString())) && this.workerBalanceRequired.isSatisfied) {
      // all filled, nothing to do
      return transactionHashes
    }
    const mustWithdrawHubDeposit = managerEthBalance.lt(toBN(this.config.managerTargetBalance.toString())) && managerHubBalance.gte(
      toBN(this.config.minHubWithdrawalBalance))
    const isWithdrawalPending = await this.txStoreManager.isActionPending(ServerAction.DEPOSIT_WITHDRAWAL)
    if (mustWithdrawHubDeposit && !isWithdrawalPending) {
      this.logger.info(`withdrawing manager hub balance (${managerHubBalance.toString()}) to manager`)
      // Refill manager eth balance from hub balance
      const method = this.relayHubContract?.contract.methods.withdraw(toHex(managerHubBalance), this.managerAddress)
      const gasLimit = await this.transactionManager.attemptEstimateGas('Withdraw', method, this.managerAddress)
      const details: SendTransactionDetails = {
        signer: this.managerAddress,
        serverAction: ServerAction.DEPOSIT_WITHDRAWAL,
        destination: this.relayHubContract.address,
        creationBlockNumber: currentBlock,
        gasLimit,
        method
      }
      const { transactionHash } = await this.transactionManager.sendTransaction(details)
      transactionHashes.push(transactionHash)
    }
    managerEthBalance = await this.getManagerBalance()
    const mustReplenishWorker = !this.workerBalanceRequired.isSatisfied
    const isReplenishPendingForWorker = await this.txStoreManager.isActionPending(ServerAction.VALUE_TRANSFER, this.workerAddress)
    if (mustReplenishWorker && !isReplenishPendingForWorker) {
      const refill = toBN(this.config.workerTargetBalance.toString()).sub(this.workerBalanceRequired.currentValue)
      this.logger.debug(
        `== replenishServer: mgr balance=${managerEthBalance.toString()}  manager hub balance=${managerHubBalance.toString()}
          \n${this.workerBalanceRequired.description}\n refill=${refill.toString()}`)
      if (refill.lt(managerEthBalance.sub(toBN(this.config.managerMinBalance)))) {
        this.logger.debug('Replenishing worker balance by manager eth balance')
        const details: SendTransactionDetails = {
          signer: this.managerAddress,
          serverAction: ServerAction.VALUE_TRANSFER,
          destination: this.workerAddress,
          value: toHex(refill),
          creationBlockNumber: currentBlock,
          gasLimit: defaultEnvironment.mintxgascost
        }
        const { transactionHash } = await this.transactionManager.sendTransaction(details)
        transactionHashes.push(transactionHash)
      } else {
        const message = `== replenishServer: can't replenish: mgr balance too low ${managerEthBalance.toString()} refill=${refill.toString()}`
        this.emit('fundingNeeded', message)
        this.logger.error(message)
      }
    }
    return transactionHashes
  }

  async _worker (blockNumber: number): Promise<PrefixedHexString[]> {
    if (!this.initialized) {
      await this.init()
    }
    if (blockNumber <= this.lastScannedBlock) {
      throw new Error('Attempt to scan older block, aborting')
    }
    if (!this._shouldRefreshState(blockNumber)) {
      return []
    }
    this.lastRefreshBlock = blockNumber
    await this._refreshGasPrice()
    await this.registrationManager.refreshBalance()
    if (!this.registrationManager.balanceRequired.isSatisfied) {
      this.setReadyState(false)
      return []
    }
    return await this._handleChanges(blockNumber)
  }

  async _refreshGasPrice (): Promise<void> {
    const gasPriceString = await this.contractInteractor.getGasPrice()
    this.gasPrice = Math.floor(parseInt(gasPriceString) * this.config.gasPriceFactor)
    if (this.gasPrice === 0) {
      throw new Error('Could not get gasPrice from node')
    }
  }

  async _handleChanges (blockNumber: number): Promise<PrefixedHexString[]> {
    let transactionHashes: PrefixedHexString[] = []
    const hubEventsSinceLastScan = await this.getAllHubEventsSinceLastScan()
    const shouldRegisterAgain = await this._shouldRegisterAgain(blockNumber, hubEventsSinceLastScan)
    transactionHashes = transactionHashes.concat(await this.registrationManager.handlePastEvents(hubEventsSinceLastScan, this.lastScannedBlock, blockNumber, shouldRegisterAgain))
    await this.transactionManager.removeConfirmedTransactions(blockNumber)
    await this._boostStuckPendingTransactions(blockNumber)
    this.lastScannedBlock = blockNumber
    const isRegistered = await this.registrationManager.isRegistered()
    if (!isRegistered) {
      this.setReadyState(false)
      return transactionHashes
    }
    await this.handlePastHubEvents(blockNumber, hubEventsSinceLastScan)
    const workerIndex = 0
    transactionHashes = transactionHashes.concat(await this.replenishServer(workerIndex, blockNumber))
    const workerBalance = await this.getWorkerBalance(workerIndex)
    if (workerBalance.lt(toBN(this.config.workerMinBalance))) {
      this.setReadyState(false)
      return transactionHashes
    }
    this.setReadyState(true)
    if (this.alerted && this.alertedBlock + this.config.alertedBlockDelay < blockNumber) {
      this.logger.warn(`Relay exited alerted state. Alerted block: ${this.alertedBlock}. Current block number: ${blockNumber}`)
      this.alerted = false
    }
    return transactionHashes
  }

  async getManagerBalance (): Promise<BN> {
    return toBN(await this.contractInteractor.getBalance(this.managerAddress, 'pending'))
  }

  async getWorkerBalance (workerIndex: number): Promise<BN> {
    return toBN(await this.contractInteractor.getBalance(this.workerAddress, 'pending'))
  }

  async _shouldRegisterAgain (currentBlock: number, hubEventsSinceLastScan: EventData[]): Promise<boolean> {
    const isPendingActivityTransaction =
      (await this.txStoreManager.isActionPending(ServerAction.RELAY_CALL)) ||
      (await this.txStoreManager.isActionPending(ServerAction.REGISTER_SERVER))
    if (this.config.registrationBlockRate === 0 || isPendingActivityTransaction) {
      return false
    }
    const latestTxBlockNumber = await this._getLatestTxBlockNumber(hubEventsSinceLastScan)
    return currentBlock - latestTxBlockNumber >= this.config.registrationBlockRate
  }

  _shouldRefreshState (currentBlock: number): boolean {
    return currentBlock - this.lastRefreshBlock >= this.config.refreshStateTimeoutBlocks || !this.isReady()
  }

  async handlePastHubEvents (blockNumber: number, hubEventsSinceLastScan: EventData[]): Promise<void> {
    for (const event of hubEventsSinceLastScan) {
      switch (event.event) {
        case TransactionRejectedByPaymaster:
          this.logger.debug(`handle TransactionRejectedByPaymaster event: ${JSON.stringify(event)}`)
          await this._handleTransactionRejectedByPaymasterEvent(blockNumber)
          break
      }
    }
  }

  async getAllHubEventsSinceLastScan (): Promise<EventData[]> {
    const topics = [address2topic(this.managerAddress)]
    const options = {
      fromBlock: this.lastScannedBlock + 1,
      toBlock: 'latest'
    }
    const events = await this.contractInteractor.getPastEventsForHub(topics, options)
    return events
  }

  async _handleTransactionRejectedByPaymasterEvent (blockNumber: number): Promise<void> {
    this.alerted = true
    this.alertedBlock = blockNumber
    this.logger.error(`Relay entered alerted state. Block number: ${blockNumber}`)
  }

  async _getLatestTxBlockNumber (eventsSinceLastScan: EventData[]): Promise<number> {
    const latestTransactionSinceLastScan = getLatestEventData(eventsSinceLastScan)
    if (latestTransactionSinceLastScan != null) {
      this.lastMinedActiveTransaction = latestTransactionSinceLastScan
    }
    if (this.lastMinedActiveTransaction == null) {
      this.lastMinedActiveTransaction = await this._queryLatestActiveEvent()
    }
    return this.lastMinedActiveTransaction?.blockNumber ?? -1
  }

  async _queryLatestActiveEvent (): Promise<EventData | undefined> {
    const events: EventData[] = await this.contractInteractor.getPastEventsForHub([address2topic(this.managerAddress)], {
      fromBlock: 1
    })
    return getLatestEventData(events)
  }

  /**
   * Resend the earliest pending transactions of all signers (manager, workers)
   * @return the receipt from the first request
   */
  async _boostStuckPendingTransactions (blockNumber: number): Promise<PrefixedHexString[]> {
    const transactionHashes: PrefixedHexString[] = []
    // repeat separately for each signer (manager, all workers)
    let signedTx = await this._boostStuckTransactionsForManager(blockNumber)
    if (signedTx != null) {
      transactionHashes.push(signedTx)
    }
    for (const workerIndex of [0]) {
      signedTx = await this._boostStuckTransactionsForWorker(blockNumber, workerIndex)
      if (signedTx != null) {
        transactionHashes.push(signedTx)
      }
    }
    return transactionHashes
  }

  async _boostStuckTransactionsForManager (blockNumber: number): Promise<PrefixedHexString | null> {
    return await this.transactionManager.boostOldestPendingTransactionForSigner(this.managerAddress, blockNumber)
  }

  async _boostStuckTransactionsForWorker (blockNumber: number, workerIndex: number): Promise<PrefixedHexString | null> {
    const signer = this.workerAddress
    return await this.transactionManager.boostOldestPendingTransactionForSigner(signer, blockNumber)
  }

  _isTrustedPaymaster (paymaster: string): boolean {
    return this.trustedPaymastersGasLimits.get(paymaster.toLocaleLowerCase()) != null
  }

  isReady (): boolean {
    if (this.lastSuccessfulRounds < this.config.successfulRoundsForReady) {
      return false
    }
    return this.ready
  }

  setReadyState (isReady: boolean): void {
    if (this.isReady() !== isReady) {
      if (isReady) {
        if (this.lastSuccessfulRounds < this.config.successfulRoundsForReady) {
          const roundsUntilReady = this.config.successfulRoundsForReady - this.lastSuccessfulRounds
          this.logger.warn(chalk.yellow(`Relayer state: almost READY (in ${roundsUntilReady} rounds)`))
        } else {
          this.logger.warn(chalk.greenBright('Relayer state: READY'))
        }
      } else {
        this.logger.warn(chalk.redBright('Relayer state: NOT-READY'))
      }
    }
    this.ready = isReady
  }
}

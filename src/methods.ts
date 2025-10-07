import {
    Address,
    beginCell,
    Cell,
    Dictionary,
    loadOutList,
    loadShardAccount,
    loadTransaction,
    ShardAccount,
    storeMessage,
    storeShardAccount,
    Transaction,
} from "@ton/core"
import axios, {AxiosResponse} from "axios"
import {
    AccountFromAPI,
    Block,
    BlockInfo,
    BlocksResponse,
    ComputeInfo,
    GetLibResponse,
    RawTransaction,
    StateFromAPI,
    TraceMoneyResult,
    TransactionData,
} from "./types"
import {TonClient, TonClient4} from "@ton/ton"
import {EmulationResult, EmulationResultSuccess} from "@ton/sandbox/dist/executor/Executor"
import {Blockchain, Executor} from "@ton/sandbox"
import {base64ToBigint, wait} from "./utils"
import {AccountState as CoreAccountState} from "@ton/core/dist/types/AccountState"

// We don't usually want to store keys this way, but without keys it's almost
// impossible to use API calls :(
const TONCENTER_API_KEY =
    process.env["TONCENTER_API_KEY"] ??
    "49efa980ccdcd018fd09d387e63537afd9db4dbb8509d69e7bc2303ca2b2c860"
const DTON_API_KEY = process.env["DTON_API_KEY"] ?? "fpYxhGTWfIe3ZEf2s6vvgAGmps_qnNmD"
const BASE_TIMEOUT = 20_000

/**
 * Minimal “handle” for locating a transaction on the TON blockchain.
 * A tuple of (lt, hash, address) is guaranteed to be unique and can be
 * passed to RPC methods such as `getAccountTransactions` to retrieve
 * the full on‑chain record.
 *
 * Can be obtained by {@link findBaseTxByHash}.
 */
export interface BaseTxInfo {
    /**
     * Logical‑time of the transaction.
     */
    lt: bigint
    /**
     * Raw 256‑bit hash of the transaction BoC.
     */
    hash: Buffer
    /**
     * Contract address that issued / owns the transaction.
     */
    address: Address
}

/**
 * Returns base transaction information by its hash.
 * @param testnet if true finds in testnet otherwise in mainnet
 * @param txHash  transaction hash to find
 */
export const findBaseTxByHash = async (
    testnet: boolean,
    txHash: string,
): Promise<BaseTxInfo | undefined> => {
    const res: AxiosResponse<TransactionData> = await axios.get(
        `https://${testnet ? "testnet." : ""}toncenter.com/api/v3/transactions`,
        {
            params: {hash: txHash, limit: 1},
            headers: {
                "X-API-Key": TONCENTER_API_KEY,
            },
        },
    )
    const transactionInfo = res.data

    const rawTx = transactionInfo.transactions.at(0)
    if (rawTx === undefined) {
        return undefined
    }

    const lt = BigInt(rawTx.lt)
    const hash = Buffer.from(rawTx.hash, "base64")
    const address = Address.parseRaw(rawTx.account)

    return {lt, hash, address}
}

/**
 * Returns full information for transaction by base information obtained from `findBaseTxByHash`
 * @param testnet if true finds in testnet otherwise in mainnet
 * @param info    information for search
 */
export const findRawTxByHash = async (
    testnet: boolean,
    info: BaseTxInfo,
): Promise<RawTransaction[]> => {
    const {lt, hash, address} = info
    const clientV4 = createTonClient4(testnet)
    return clientV4.getAccountTransactions(address, lt, hash)
}

/**
 * Return the shard‑block header that contains a given
 * {@link RawTransaction}.
 *
 * @param testnet  Mainnet/testnet flag.
 * @param tx       Raw transaction object.
 * @returns        The matching shard‑block or `undefined`
 *                 if Toncenter cannot find it.
 */
export const findShardBlockForTx = async (
    testnet: boolean,
    tx: RawTransaction,
): Promise<Block | undefined> => {
    const shard = tx.block

    // normalize potentially negative shard to positive one
    const shardInt = BigInt(shard.shard)
    const shardUint = shardInt < 0 ? shardInt + BigInt("0x10000000000000000") : shardInt

    const res: AxiosResponse<BlocksResponse> = await axios.get(
        `https://${testnet ? "testnet." : ""}toncenter.com/api/v3/blocks`,
        {
            params: {
                workchain: shard.workchain,
                shard: "0x" + shardUint.toString(16),
                seqno: shard.seqno,
            },
            headers: {
                "X-API-Key": TONCENTER_API_KEY,
            },
        },
    )

    return res.data.blocks[0]
}

/**
 * Return a master‑block (full representation, including `shards[]`)
 * by its `seqno` via TON API v4.
 *
 * @param testnet  Mainnet/testnet flag.
 * @param seqno    Master‑block sequence number.
 * @returns        The complete {@link BlockInfo}.
 */
export const findFullBlockForSeqno = async (
    testnet: boolean,
    seqno: number,
): Promise<BlockInfo> => {
    return createTonClient4(testnet).getBlock(seqno)
}

/**
 * Retrieve all transactions of a given account whose logical‑time
 * lies in the interval `(minLt, baseTx.lt]`, inclusive of `baseTx`.
 *
 * Used to reconstruct in‑block history before emulation.
 *
 * @param testnet  Mainnet/testnet flag.
 * @param baseTx   The “upper bound” transaction.
 * @param minLt    Lower logical‑time boundary
 * @returns        Transactions ordered **newest → oldest**.
 */
export const findAllTransactionsBetween = async (
    testnet: boolean,
    baseTx: BaseTxInfo,
    minLt: bigint,
): Promise<Transaction[]> => {
    const clientV2 = new TonClient({
        endpoint: `https://${testnet ? "testnet." : ""}toncenter.com/api/v2/jsonRPC`,
        timeout: BASE_TIMEOUT,
        apiKey: TONCENTER_API_KEY,
    })

    return clientV2.getTransactions(baseTx.address, {
        inclusive: true,
        lt: baseTx.lt.toString(),
        to_lt: (minLt - 1n).toString(),
        hash: baseTx.hash.toString("base64"),
        archival: true,
        limit: 1000,
    })
}

/**
 * Load the global configuration cell valid for the master‑block that
 * encloses the target transaction. Required by the TVM executor to
 * calculate gas, random‑seed and limits exactly as onchain.
 *
 * @param testnet   Mainnet/testnet flag.
 * @param block     Full master‑block object (with `shards[]` array).
 * @returns         Config cell as a string.
 */
export const getBlockConfig = async (testnet: boolean, block: BlockInfo): Promise<string> => {
    const clientV4 = createTonClient4(testnet)

    const blockSeqno = block.shards[0].seqno
    const res = await clientV4.getConfig(blockSeqno)
    return res.config.cell
}

/**
 * Return an account snapshot *before* the current master‑block.
 * The snapshot is converted to {@link ShardAccount} so it can be
 * directly fed into `runTransaction`.
 *
 * @param testnet   Mainnet/testnet flag.
 * @param address   Account address.
 * @param block     Master‑block N (the one that contains the tx).
 * @returns         ShardAccount representing state on master‑block N‑1.
 */
export const getBlockAccount = async (
    testnet: boolean,
    address: Address,
    block: BlockInfo,
): Promise<ShardAccount> => {
    const blockSeqno = block.shards[0].seqno

    const clientV4 = createTonClient4(testnet)
    try {
        const res = await clientV4.getAccount(blockSeqno - 1, address)
        return createShardAccountFromAPI(res.account, address)
    } catch (error: unknown) {
        // @ton/ton testnet integration broken right now, fallback
        console.error("Cannot get account from API", error)
        const res = await getBlockAccountFallback(testnet, blockSeqno - 1, address)
        return createShardAccountFromAPI(res.data.account, address)
    }
}

async function getBlockAccountFallback(
    testnet: boolean,
    seqno: number,
    address: Address,
): Promise<
    AxiosResponse<{
        account: AccountFromAPI
    }>
> {
    const endpoint = `https://${testnet ? "sandbox" : "mainnet"}-v4.tonhubapi.com`
    const path = `${endpoint}/block/${seqno}/${address.toString({urlSafe: true})}`
    return axios.get(path)
}

/**
 * Scan every shard‑summary inside a master‑block and return the
 * smallest `lt` for the specified account. This value marks the
 * earliest transaction of the account inside that master‑block.
 *
 * @param tx         Target (latest) transaction object.
 * @param address    Account address.
 * @param block      Master‑block that contains `tx`.
 * @returns          Minimum logical‑time as `bigint`.
 */
export const computeMinLt = (tx: Transaction, address: Address, block: BlockInfo): bigint => {
    let minLt = tx.lt
    const addrStr = address.toString()
    for (const shard of block.shards) {
        for (const txInBlock of shard.transactions) {
            if (txInBlock.account === addrStr && BigInt(txInBlock.lt) < minLt) {
                minLt = BigInt(txInBlock.lt)
            }
        }
    }
    return minLt
}

/**
 * Load a library cell (T‑lib) from toncenter or dton.io GraphQL by its
 * 256‑bit hash.
 *
 * @param testnet  Mainnet/testnet flag.
 * @param hash     Hex string of the library hash.
 * @returns        Decoded {@link Cell} containing actual code.
 * @throws         Error if the library is missing on the server.
 */
export const getLibraryByHash = async (testnet: boolean, hash: string): Promise<Cell> => {
    try {
        return await getLibraryByHashToncenter(testnet, hash)
    } catch (error: unknown) {
        console.log("Cannot get library by hash from toncenter:", error)
        console.log("Trying dton...")

        return getLibraryByHashDton(testnet, hash)
    }
}

/**
 * Load a library cell (T‑lib) from dton.io GraphQL by its
 * 256‑bit hash.
 *
 * @param testnet  Mainnet/testnet flag.
 * @param hash     Hex string of the library hash.
 * @returns        Decoded {@link Cell} containing actual code.
 * @throws         Error if the library is missing on the server.
 */
export const getLibraryByHashDton = async (testnet: boolean, hash: string): Promise<Cell> => {
    await wait(1000) // needed if we load several libs in a row
    const dtonEndpoint = `https://${testnet ? "testnet." : ""}dton.io/${DTON_API_KEY}/graphql`
    const graphqlQuery = {
        query: `query fetchAuthor { get_lib(lib_hash: "${hash}") }`,
        variables: {},
    }
    try {
        const res: AxiosResponse<GetLibResponse> = await axios.post(dtonEndpoint, graphqlQuery, {
            headers: {
                "Content-Type": "application/json",
            },
        })
        return Cell.fromBase64(res.data.data.get_lib)
    } catch (error) {
        console.error("Error fetching library from dton:", error)
        if (error instanceof Error) {
            throw new Error("Get library on dton's graphql: " + error.message)
        }
        throw error
    }
}

/**
 * Load a library cell (T‑lib) from toncenter by its
 * 256‑bit hash.
 *
 * @param testnet  Mainnet/testnet flag.
 * @param hash     Hex string of the library hash.
 * @returns        Decoded {@link Cell} containing actual code.
 * @throws         Error if the library is missing on the server.
 */
export const getLibraryByHashToncenter = async (testnet: boolean, hash: string): Promise<Cell> => {
    try {
        const endpoint = `https://${testnet ? "testnet." : ""}toncenter.com/api/v2/getLibraries`
        const res: AxiosResponse<{
            ok: boolean
            result: {result: {hash: string; data: string}[]}
        }> = await axios.get(endpoint, {
            params: {libraries: hash},
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": TONCENTER_API_KEY,
            },
        })
        return Cell.fromBase64(res.data.result.result[0].data)
    } catch (error) {
        console.error("Error fetching library from toncenter:", error)
        if (error instanceof Error) {
            throw new Error("Get library on toncenter: " + error.message)
        }
        throw error
    }
}

/**
 * Inspect the contract’s current code and (optionally) the init
 * code of the pending message, detect all **exotic library cells**
 * (tag 2) and build a dict mapping hash → real library code.
 *
 * @param testnet          Mainnet/testnet flag.
 * @param account          Current {@link ShardAccount} snapshot.
 * @param additionalLibs   Additional libraries to use.
 * @param tx               Transaction whose `inMessage` may include `Init`.
 * @returns                Serialized dict cell or `undefined`
 *                         when no libraries are referenced and actual code cell if
 *                         original code is just an exotic library cell
 */
export const collectUsedLibraries = async (
    testnet: boolean,
    account: ShardAccount,
    tx: Transaction,
    additionalLibs: [bigint, Cell][],
): Promise<[Cell | undefined, Cell | undefined]> => {
    const libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())

    const addMaybeExoticLibrary = async (code: Cell | undefined): Promise<Cell | undefined> => {
        const EXOTIC_LIBRARY_TAG = 2
        if (code === undefined) return undefined
        if (code.bits.length !== 256 + 8) return undefined // not an exotic library cell

        const cs = code.beginParse(true) // allow exotics
        const tag = cs.loadUint(8)
        if (tag !== EXOTIC_LIBRARY_TAG) return undefined // not a library cell

        const libHash = cs.loadBuffer(32)
        const libHashHex = libHash.toString("hex").toUpperCase()
        const actualCode = await getLibraryByHash(testnet, libHashHex)
        libs.set(BigInt(`0x${libHashHex}`), actualCode)
        return actualCode
    }

    // if current contract code is exotic cell, we want to return actual code to the user
    let loadedCellCode: Cell | undefined = undefined

    // 1. scan the *current* contract code for exotic‑library links
    const state = account.account?.storage.state
    if (state?.type === "active") {
        // The contract is already deployed and “active” so its `code`
        // cell may itself be a 264‑bit exotic library reference (tag 2).
        // If that’s the case, download the real library code and
        // register it in the `libs` dictionary.
        loadedCellCode = await addMaybeExoticLibrary(state.state.code ?? undefined)
    }

    // 2. scan the *incoming StateInit* (if present)
    const init = tx.inMessage?.init
    if (init) {
        // This transaction might *deploy* a brand‑new contract or
        // *upgrade* the existing one. Its `StateInit.code` could also
        // be an exotic library cell. We must preload such libraries as
        // well, otherwise the sandbox would fail to resolve a library
        // during emulation.
        loadedCellCode ??= await addMaybeExoticLibrary(init.code ?? undefined)
    }

    for (const [hash, lib] of additionalLibs) {
        libs.set(hash, lib)
    }

    // no libs found, return undefined, for emulator this means no libraries
    if (libs.size === 0) return [undefined, loadedCellCode]

    // emulator expects libraries as a Cell with immediate dictionary
    return [beginCell().storeDictDirect(libs).endCell(), loadedCellCode]
}

/**
 * Convert an account record received from Toncenter / Tonhub API
 * (`AccountFromAPI`) into the low‑level `ShardAccount` structure
 * expected by core TON libraries and the sandbox executor.
 *
 * @param apiAccount  Raw JSON account object from REST API.
 * @param address     Parsed {@link Address} of the account
 *                    (API does not always include it).
 * @returns           A fully‑typed {@link ShardAccount} ready for
 *                    serialization with `storeShardAccount`.
 */
export function createShardAccountFromAPI(
    apiAccount: AccountFromAPI,
    address: Address,
): ShardAccount {
    const toBigint = (num: number | undefined): bigint => (num === undefined ? 0n : BigInt(num))

    return {
        account: {
            addr: address,
            storage: {
                lastTransLt: BigInt(apiAccount.last?.lt ?? 0),
                balance: {coins: BigInt(apiAccount.balance.coins)},
                state: normalizeStateFromAPI(apiAccount.state),
            },
            storageStats: {
                used: {
                    cells: toBigint(apiAccount.storageStat?.used.cells),
                    bits: toBigint(apiAccount.storageStat?.used.bits),
                },
                lastPaid: apiAccount.storageStat?.lastPaid ?? 0,
                duePayment:
                    typeof apiAccount.storageStat?.duePayment === "string"
                        ? BigInt(apiAccount.storageStat.duePayment)
                        : undefined,
                storageExtra: null,
            },
        },
        lastTransactionLt: BigInt(apiAccount.last?.lt ?? 0),
        lastTransactionHash:
            apiAccount.last?.hash === undefined ? 0n : base64ToBigint(apiAccount.last.hash),
    }
}

/**
 * Transform the `state` sub‑object of an API response into the canonical
 * `AccountState` union used by `@ton/core`.
 *
 * @param givenState  State payload exactly as returned by Toncenter API.
 * @returns           Normalised `AccountState` object suitable for TVM.
 */
export function normalizeStateFromAPI(givenState: StateFromAPI): CoreAccountState {
    if (givenState.type === "uninit") {
        return {type: "uninit"}
    }

    if (givenState.type === "frozen") {
        return {
            type: "frozen",
            stateHash: base64ToBigint(givenState.stateHash),
        }
    }

    return {
        type: "active",
        state: {
            code: givenState.code === null ? undefined : Cell.fromBase64(givenState.code),
            data: givenState.data === null ? undefined : Cell.fromBase64(givenState.data),
        },
    }
}

/**
 * Sequentially emulate the list of earlier transactions to roll
 * the shard‑account forward until the moment right before the
 * target transaction. Returns the updated balance and the new
 * base64‑encoded shard‑account string.
 *
 * @param prevBalance         Balance at the snapshot start.
 * @param prevTxsInBlock      Transactions to replay (oldest → newest).
 * @param emulate             Helper that runs a single transaction.
 * @param shardAccountBase64  Starting shard‑account (base64).
 * @returns                   `{ prevBalance, shardAccountBase64 }`
 *                            after applying all txs.
 */
export const emulatePreviousTransactions = async (
    prevBalance: bigint,
    prevTxsInBlock: Transaction[],
    emulate: (tx: Transaction, shardAccountStr: string) => Promise<EmulationResult>,
    shardAccountBase64: string,
): Promise<{prevBalance: bigint; shardAccountBase64: string}> => {
    if (prevTxsInBlock.length === 0) {
        return {prevBalance, shardAccountBase64}
    }

    for (const tx of prevTxsInBlock) {
        const res = await emulate(tx, shardAccountBase64)
        if (!res.result.success) {
            throw new Error(
                `Transaction failed for lt: ${tx.lt}, logs: ${res.logs}, debugLogs: ${res.debugLogs}`,
            )
        }

        // since we change state at each transaction we need to save new state as current one
        shardAccountBase64 = res.result.shardAccount

        const shardAccount = loadShardAccount(Cell.fromBase64(shardAccountBase64).asSlice())
        const newBalance = shardAccount.account?.storage.balance.coins

        prevBalance = newBalance ?? 0n
    }

    return {prevBalance, shardAccountBase64}
}

/**
 * Spin up TON Sandbox, configure verbosity, wrap the executor
 * into a convenience helper `emulate` and return both the helper
 * and the sandbox version metadata.
 *
 * @param blockConfig  Global config cell.
 * @param libs         Dict of referenced libraries or `undefined`.
 * @param randSeed     Random seed from master‑block header.
 * @returns            `{ emulatorVersion, emulate }`
 */
export const prepareEmulator = async (
    blockConfig: string,
    libs: Cell | undefined,
    randSeed: Buffer,
) => {
    const blockchain = await Blockchain.create()
    blockchain.verbosity.print = false // don't print logs to stdout
    blockchain.verbosity.vmLogs = "vm_logs_verbose" // most verbose logs including full Cells

    const executor = blockchain.executor
    const emulatorVersion =
        executor instanceof Executor
            ? executor.getVersion()
            : {
                  commitHash: "",
                  commitDate: "",
              }

    async function emulate(tx: Transaction, shardAccountBase64: string): Promise<EmulationResult> {
        const inMsg = tx.inMessage
        if (!inMsg) throw new Error("No in_message was found in transaction")

        return executor.runTransaction({
            config: blockConfig,
            libs: libs ?? null,
            verbosity: "full_location_stack_verbose",
            shardAccount: shardAccountBase64,
            message: beginCell().store(storeMessage(inMsg)).endCell(),
            now: tx.now,
            lt: tx.lt,
            randomSeed: randSeed,
            ignoreChksig: false,
            debugEnabled: true,
        })
    }

    return {emulatorVersion, emulate}
}

/**
 * Convert the raw `EmulationResultSuccess` plus the prior balance
 * into a structured set of money movements, compute‑phase stats and
 * convenience fields for higher‑level reporting.
 *
 * @param res            Successful result from TVM executor.
 * @param balanceBefore  Balance **before** the emulated tx.
 * @returns              Breakdown containing sender/dest, amounts,
 *                       gas usage and the parsed `emulatedTx`.
 */
export const computeFinalData = (res: EmulationResultSuccess, balanceBefore: bigint) => {
    const shardAccount = loadShardAccount(Cell.fromBase64(res.shardAccount).asSlice())
    const endBalance = shardAccount.account?.storage.balance.coins ?? 0n

    const emulatedTx = loadTransaction(Cell.fromBase64(res.transaction).asSlice())
    if (!emulatedTx.inMessage) {
        throw new Error("No in_message was found in result tx")
    }

    const src = emulatedTx.inMessage.info.src ?? undefined
    const dest = emulatedTx.inMessage.info.dest

    if (src !== undefined && !Address.isAddress(src)) {
        throw new Error(`Invalid src address: ${src.toString()}`)
    }
    if (!Address.isAddress(dest)) {
        throw new Error(`Invalid dest address: ${dest?.toString()}`)
    }

    const amount =
        emulatedTx.inMessage.info.type === "internal"
            ? emulatedTx.inMessage.info.value.coins
            : undefined

    const sentTotal = calculateSentTotal(emulatedTx)
    const totalFees = emulatedTx.totalFees.coins

    if (emulatedTx.description.type !== "generic") {
        throw new Error(
            "TxTracer doesn't support non-generic transaction. Given type: " +
                emulatedTx.description.type,
        )
    }

    const computePhase = emulatedTx.description.computePhase
    const computeInfo: ComputeInfo =
        computePhase.type === "skipped"
            ? "skipped"
            : {
                  success: computePhase.success,
                  exitCode:
                      computePhase.exitCode === 0
                          ? (emulatedTx.description.actionPhase?.resultCode ?? 0)
                          : computePhase.exitCode,
                  vmSteps: computePhase.vmSteps,
                  gasUsed: computePhase.gasUsed,
                  gasFees: computePhase.gasFees,
              }

    const money: TraceMoneyResult = {
        balanceBefore,
        sentTotal,
        totalFees,
        balanceAfter: endBalance,
    }

    return {
        sender: src,
        contract: dest,
        money,
        emulatedTx,
        amount,
        computeInfo,
    }
}

/**
 * Extract the final `c5` register (action list) from emulation results,
 * decode it into an array of `OutAction`s and
 * return both the list and the original `c5` cell.
 *
 * @param res  Successful emulation result.
 * @returns    `{ finalActions, c5 }`
 */
export const findFinalActions = (res: EmulationResultSuccess) => {
    const actions = res.actions
    if (actions === null) {
        return {finalActions: [], c5: undefined}
    }

    const c5 = Cell.fromBase64(actions)
    const finalActions = loadOutList(c5.asSlice())
    return {finalActions, c5}
}

/**
 * Sum the value (`coins`) of every *internal* outgoing message
 * produced by a transaction. External messages are ignored since its
 * value is always 0.
 *
 * @param tx  Parsed {@link Transaction}.
 * @returns   Total toncoins sent out by the contract in this tx.
 */
export const calculateSentTotal = (tx: Transaction): bigint => {
    let total = 0n
    for (const msg of tx.outMessages.values()) {
        if (msg.info.type === "internal") {
            total += msg.info.value.coins
        }
    }
    return total
}

/**
 * Helper to serialize a {@link ShardAccount} object into base64
 * exactly as expected by `executor.runTransaction`.
 *
 * @param shardAccountBeforeTx  Account snapshot to serialize.
 * @returns                     Base64 string of the BOC‑encoded cell.
 */
export const shardAccountToBase64 = (shardAccountBeforeTx: ShardAccount) =>
    beginCell().store(storeShardAccount(shardAccountBeforeTx)).endCell().toBoc().toString("base64")

const createTonClient4 = (testnet: boolean) =>
    new TonClient4({
        endpoint: `https://${testnet ? "sandbox" : "mainnet"}-v4.tonhubapi.com`,
        timeout: BASE_TIMEOUT,
        requestInterceptor: config => {
            config.headers["Content-Type"] = "application/json"
            return config
        },
    })

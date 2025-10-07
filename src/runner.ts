import {TraceResult} from "./types"
import {
    BaseTxInfo,
    collectUsedLibraries,
    computeFinalData,
    computeMinLt,
    emulatePreviousTransactions,
    findAllTransactionsBetween,
    findBaseTxByHash,
    findFinalActions,
    findFullBlockForSeqno,
    findRawTxByHash,
    findShardBlockForTx,
    getBlockAccount,
    getBlockConfig,
    getLibraryByHash,
    prepareEmulator,
    shardAccountToBase64,
} from "./methods"
import {Buffer} from "buffer"
import {beginCell, Cell, storeTransaction, Transaction} from "@ton/core"
import {logs} from "ton-assembly"

/**
 * Fully reproduce (re‑trace) a TON transaction inside a local TON Sandbox
 * and return a structured report with VM logs, money flow, generated
 * actions and other data.
 *
 * Workflow (high level)
 * 1.  Locate the base transaction (`txLink`) on either mainnet or testnet.
 * 2.  Load its shard‑block and the enclosing master‑block; extract
 *     `rand_seed`, config‑cell and the account snapshot *prior* to the block.
 * 3.  Re‑create the exact pre‑tx state by sequentially emulating all earlier
 *     account transactions that happened inside the same master‑block.
 * 4.  Emulate the target transaction itself with full VM verbosity.
 * 5.  Parse the resulting VM log (`c5`, action list, stack trace), compare the
 *     calculated state‑hash with the on‑chain one and assemble a
 *     `TraceResult` object for the caller.
 *
 * @param testnet         When `true`, work against testnet endpoints; otherwise mainnet.
 * @param txLink          Hex hash that uniquely identifies the transaction to retrace.
 * @param additionalLibs  Additional libraries to use.
 *
 * @returns        A {@link TraceResult} containing:
 *                 1. an integrity flag `stateUpdateHashOk`
 *                 2. decoded an incoming message (sender / contract / amount)
 *                 3. balance delta, gas and fees
 *                 4. full emulated transaction (`emulatedTx`) with
 *                   compute‑phase info, `c5`, action list and raw VM log
 *                 5. version of the sandbox executor used for emulation
 *
 * @throws Error   If any network lookup fails; if the corresponding shard‑ /
 *                 master‑block cannot be found; if deterministic replay
 *                 diverges (TVM returns non‑success); or if state‑hash
 *                 mismatch is detected after replay.
 */
export const retrace = async (
    testnet: boolean,
    txLink: string,
    additionalLibs: [bigint, Cell][] = [],
): Promise<TraceResult> => {
    const baseTx = await findBaseTxByHash(testnet, txLink)
    if (baseTx === undefined) {
        throw new Error("Cannot find transaction info")
    }
    const result = await retraceBaseTx(testnet, baseTx, additionalLibs)
    if (result.emulatedTx.computeInfo === "skipped") {
        return result
    }

    if (result.emulatedTx.computeInfo.exitCode === 0) {
        // fast path
        return result
    }

    if (result.emulatedTx.computeInfo.exitCode === 9) {
        // This can be both a simple cell underflow and failed to load a library cell.
        // Parse vmLogs to find out.

        // Example stack:
        //
        // stack: [ ... C{B5EE9C72010101010023000842029468B29F43AC803FC9F621953FDD069A432E4CD1D9A56B9C299B587FE6898FAB} ]
        // code cell hash: 4F5F4CE417F91358B532A9670A09D20AC7E01850E9B704A4DF1CC5373EE6EDE4 offset: 887
        // execute CTOS
        // handling exception code 9: failed to load library cell
        // default exception handler, terminating vm with exit code 9

        const lines = logs.parse(result.emulatedTx.vmLogs)

        const exceptionHandlerLine = lines.at(-2)
        const exceptionLine = lines.at(-3)
        const ctosLine = lines.at(-4)
        const stackLine = lines.at(-6)
        if (
            exceptionHandlerLine?.$ === "VmExceptionHandler" &&
            exceptionLine?.$ === "VmException" &&
            exceptionLine.message === "failed to load library cell" &&
            ctosLine?.$ === "VmExecute" &&
            ctosLine.instr === "CTOS" &&
            stackLine?.$ === "VmStack"
        ) {
            // So we find out that the transaction failed to load a library cell.
            // Stack before CTOS will contain the library cell as the top element.
            const topElement = stackLine.stack.at(-1)
            if (topElement?.$ === "Cell") {
                const libraryResult = await tryLoadAsLibrary(topElement.boc, testnet)
                if (libraryResult === undefined) {
                    // Either the library cell is not an exotic library cell, or we cannot load it.
                    return result
                }

                // Now we have the library content and hash, so we try again with this library.
                const {libHashHex, actualCode} = libraryResult
                const additionalLib: [bigint, Cell] = [BigInt(`0x${libHashHex}`), actualCode]
                return retrace(testnet, txLink, [...additionalLibs, additionalLib])
            }
        }
    }

    return result
}

/**
 * Fully reproduce (re‑trace) a TON transaction inside a local TON Sandbox
 * and return a structured report with VM logs, money flow, generated
 * actions and other data.
 *
 * See {@link retrace} for the full description of the workflow.
 */
export const retraceBaseTx = async (
    testnet: boolean,
    baseTx: BaseTxInfo,
    additionalLibs: [bigint, Cell][] = [],
): Promise<TraceResult> => {
    const [tx] = await findRawTxByHash(testnet, baseTx)
    // eslint bug
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (tx === undefined) {
        throw new Error("Cannot find transaction info")
    }
    const shard = tx.block
    const block = await findShardBlockForTx(testnet, tx)
    if (block === undefined) {
        throw new Error("Cannot find shard block for transaction")
    }
    // check if we correctly select master-block
    if (block.root_hash !== shard.rootHash) {
        throw new Error(
            `root_hash mismatch in mc_seqno getter: ${shard.rootHash} != ${block.root_hash}`,
        )
    }

    // master‑block sequence number that references our shard‑block
    const mcSeqno = block.masterchain_block_ref.seqno
    // pseudorandom seed from the master‑block header — TVM needs it for deterministic RNG
    const randSeed = Buffer.from(block.rand_seed, "base64")
    // load the complete master‑block object (includes the list of shard‑blocks)
    const fullBlock = await findFullBlockForSeqno(testnet, mcSeqno)
    // determine the earliest logical‑time (lt) for this account in the same master‑block
    const minLt = computeMinLt(tx.tx, baseTx.address, fullBlock)
    // find all transactions between the earliest one and the emulated transaction to correctly
    // recreate all state before execution of the emulated transaction
    const [ourTx, ...prevTxsInBlock] = await findAllTransactionsBetween(testnet, baseTx, minLt)
    prevTxsInBlock.reverse() // allTxs contains txs from last to first one

    // retrieve block config to pass it to emulator
    const blockConfig = await getBlockConfig(testnet, fullBlock)
    const shardAccountBeforeTx = await getBlockAccount(testnet, baseTx.address, fullBlock)
    const [libs, loadedCode] = await collectUsedLibraries(
        testnet,
        shardAccountBeforeTx,
        tx.tx,
        additionalLibs,
    )

    // retrieve code cell if an account in active mode
    const state = shardAccountBeforeTx.account?.storage.state
    const codeCell =
        state?.type === "active"
            ? (state.state.code ?? undefined)
            : (tx.tx.inMessage?.init?.code ?? undefined)

    const {emulatorVersion, emulate} = await prepareEmulator(blockConfig, libs, randSeed)

    // for the first transaction (executor doesn't know about last tx)
    shardAccountBeforeTx.lastTransactionLt = 0n
    shardAccountBeforeTx.lastTransactionHash = 0n

    // emulator accepts and returns a shard account in base64 string, so prepare it for sending
    const initialShardAccountBase64 = shardAccountToBase64(shardAccountBeforeTx)

    // first we emulate all transactions before to get a state that is equal to actual
    // state in blockchain before transaction to emulate
    const balance = shardAccountBeforeTx.account?.storage.balance.coins ?? 0n
    const {prevBalance, shardAccountBase64} = await emulatePreviousTransactions(
        balance,
        prevTxsInBlock,
        emulate,
        initialShardAccountBase64,
    )

    // and then we emulate the target transaction
    const txRes = await emulate(ourTx, shardAccountBase64)
    if (!txRes.result.success) {
        throw new Error(`Transaction failed: ${txRes.result.error}`)
    }

    // extract out actions from the c5 control register
    const {finalActions, c5} = findFinalActions(txRes.result)

    const {sender, contract, amount, money, emulatedTx, computeInfo} = computeFinalData(
        txRes.result,
        prevBalance,
    )

    // check if the emulated transaction hash is equal to one from the real blockchain
    const stateUpdateHashOk = emulatedTx.stateUpdate.newHash.equals(ourTx.stateUpdate.newHash)

    const opcode = txOpcode(ourTx)

    return {
        stateUpdateHashOk,
        codeCell: loadedCode ?? codeCell,
        originalCodeCell: codeCell,
        inMsg: {
            sender,
            contract,
            amount,
            opcode,
        },
        money,
        emulatedTx: {
            raw: beginCell().store(storeTransaction(ourTx)).endCell().toBoc().toString("hex"),
            utime: emulatedTx.now,
            lt: emulatedTx.lt,
            computeInfo,
            executorLogs: txRes.logs,
            actions: finalActions,
            c5: c5,
            vmLogs: txRes.result.vmLog,
        },
        emulatorVersion,
    }
}

function txOpcode(transaction: Transaction): number | undefined {
    const inMessage = transaction.inMessage
    const isBounced = inMessage?.info.type === "internal" ? inMessage.info.bounced : false

    let opcode: number | undefined = undefined
    const slice = inMessage?.body.asSlice()
    if (slice) {
        if (isBounced) {
            // skip 0xFFFF..
            slice.loadUint(32)
        }
        if (slice.remainingBits >= 32) {
            opcode = slice.loadUint(32)
        }
    }

    return opcode
}

/**
 * Try to parse a given cell as a library cell and load it from the blockchain.
 */
async function tryLoadAsLibrary(
    cell: string,
    testnet: boolean,
): Promise<
    | {
          libHashHex: string
          actualCode: Cell
      }
    | undefined
> {
    const libCell = Cell.fromHex(cell)

    const EXOTIC_LIBRARY_TAG = 2
    if (libCell.bits.length !== 256 + 8) return undefined // not an exotic library cell

    const cs = libCell.beginParse(true) // allow exotics
    const tag = cs.loadUint(8)
    if (tag !== EXOTIC_LIBRARY_TAG) return undefined // not a library cell

    const libHash = cs.loadBuffer(32)
    const libHashHex = libHash.toString("hex").toUpperCase()
    const actualCode = await getLibraryByHash(testnet, libHashHex)
    return {libHashHex, actualCode}
}

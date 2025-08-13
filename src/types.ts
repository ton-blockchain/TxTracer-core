import type {Address, Cell, Transaction as CoreTransaction, OutAction} from "@ton/core"

// TonCenter v3 API response for get transactions
export interface TransactionData {
    transactions: Transaction[]
    address_book: Record<string, AddressBookEntry>
}

export interface OutMessage {
    hash: string
    source: string
    destination: string
    value: string
    fwd_fee: string
    ihr_fee: string
    created_lt: string
    created_at: string
    opcode: string
    ihr_disabled: boolean
    bounce: boolean
    bounced: boolean
    import_fee: string
    message_content: {
        hash: string
        body: string
        decoded: Record<string, unknown>
    }
    init_state: {
        hash: string
        body: string
    }
}

export interface Transaction {
    account: string
    hash: string
    lt: string
    now: number
    mc_block_seqno: number
    trace_id: string
    prev_trans_hash: string
    prev_trans_lt: string
    orig_status: string
    end_status: string
    total_fees: string
    total_fees_extra_currencies: Record<string, unknown>
    description: Description
    block_ref: BlockRef
    in_msg: InMessage
    out_msgs: OutMessage[]
    account_state_before: AccountState
    account_state_after: AccountState
    emulated: boolean
}

export interface AddressBookEntry {
    user_friendly: string
    domain: string | null
}

export interface Description {
    type: string
    aborted: boolean
    destroyed: boolean
    credit_first: boolean
    storage_ph: {
        storage_fees_collected: string
        status_change: string
    }
    credit_ph: {
        credit: string
    }
    compute_ph: {
        skipped: boolean
        success: boolean
        msg_state_used: boolean
        account_activated: boolean
        gas_fees: string
        gas_used: string
        gas_limit: string
        mode: number
        exit_code: number
        vm_steps: number
        vm_init_state_hash: string
        vm_final_state_hash: string
    }
    action: {
        success: boolean
        valid: boolean
        no_funds: boolean
        status_change: string
        result_code: number
        tot_actions: number
        spec_actions: number
        skipped_actions: number
        msgs_created: number
        action_list_hash: string
        tot_msg_size: {
            cells: string
            bits: string
        }
    }
}

export interface BlockRef {
    workchain: number
    shard: string
    seqno: number
}

export interface InMessage {
    hash: string
    source: string
    destination: string
    value: string
    value_extra_currencies: Record<string, unknown>
    fwd_fee: string
    ihr_fee: string
    created_lt: string
    created_at: number
    opcode: string
    ihr_disabled: boolean
    bounce: boolean
    bounced: boolean
    import_fee: string | null
    message_content: {
        hash: string
        body: string
        decoded: Record<string, unknown>
    }
    init_state: {
        hash: string
        body: string
    }
}

export interface AccountState {
    hash: string
    balance: string
    extra_currencies: Record<string, unknown>
    account_status: string
    frozen_hash: string | null
    data_hash: string
    code_hash: string
}

// v4 transaction info
export interface RawTransaction {
    block: {
        workchain: number
        seqno: number
        shard: string
        rootHash: string
        fileHash: string
    }
    tx: CoreTransaction
}

// dton get_lib response
export interface GetLibResponse {
    data: {
        get_lib: string
    }
    errors: unknown[]
}

// toncenter v3 blocks response
export interface BlocksResponse {
    blocks: Block[]
}

export interface Block {
    after_merge: boolean
    after_split: boolean
    before_split: boolean
    created_by: string
    end_lt: string
    file_hash: string
    flags: number
    gen_catchain_seqno: number
    gen_utime: string
    global_id: number
    key_block: boolean
    master_ref_seqno: number
    masterchain_block_ref: BlockRef
    min_ref_mc_seqno: number
    prev_blocks: BlockRef[]
    prev_key_block_seqno: number
    rand_seed: string
    root_hash: string
    seqno: number
    shard: string
    start_lt: string
    tx_count: number
    validator_list_hash_short: number
    version: number
    vert_seqno: number
    vert_seqno_incr: boolean
    want_merge: boolean
    want_split: boolean
    workchain: number
}

export interface ShardInfo {
    workchain: number
    shard: string
    seqno: number
    transactions: {
        lt: string
        hash: string
        account: string
    }[]
    fileHash: string
    rootHash: string
}

export interface BlockInfo {
    shards: ShardInfo[]
}

export type ComputeInfo =
    | "skipped"
    | {
          /**
           * If the phase is successful
           */
          success: boolean
          /**
           * Exit code of this phase
           */
          exitCode: number
          /**
           * Count of steps that VM executes until the end
           */
          vmSteps: number
          /**
           * Gas used for this phase
           */
          gasUsed: bigint
          /**
           * Gas fees for this phase
           */
          gasFees: bigint
      }

export interface TraceInMessage {
    /**
     * Sender of in-message
     *
     * Undefined if the in-message is an external message
     */
    sender: Address | undefined
    /**
     * Address of contract that received in-message.
     */
    contract: Address
    /**
     * Number of toncoin for in-message
     *
     * Undefined if the in-message is an external message
     */
    amount: bigint | undefined
    /**
     * Opcode of the in-message
     */
    opcode: number | undefined
}

export interface TraceEmulatedTx {
    /**
     * Raw BoC of the emulated transaction in hex format
     */
    raw: string
    /**
     * Unix timestamp of the emulated transaction
     */
    utime: number
    /**
     * Logical time of the emulated transaction
     */
    lt: bigint
    /**
     * Information about compute-phase for emulated transaction
     */
    computeInfo: ComputeInfo
    /**
     * Logs of emulated transaction
     */
    executorLogs: string
    /**
     * Represent parsed content of register c5 for emulated transaction
     */
    actions: OutAction[]
    /**
     * Represent raw content of register c5 as Cell for emulated transaction
     *
     * Undefined if there was no log entry for the c5 contents
     */
    c5: Cell | undefined
    /**
     * Emulated transaction execution logs from Ton Virtual Machine
     */
    vmLogs: string
}

export interface TraceMoneyResult {
    /**
     * Account balance before transaction
     */
    balanceBefore: bigint
    /**
     * Sum of all out internal messages values
     */
    sentTotal: bigint
    /**
     * The total fees collected during the transaction execution,
     * including TON coin and potentially some extra-currencies.
     */
    totalFees: bigint
    /**
     * Account balance after transaction
     */
    balanceAfter: bigint
}

// TxTracer result
export interface TraceResult {
    /**
     * Sets to true if the emulated transaction hash is equal to one from the real blockchain
     */
    stateUpdateHashOk: boolean
    /**
     * Code of an account before transaction. If code is just an exotic cell,
     * this field will contain actual library code, see {@link originalCodeCell}
     * if you need original code cell.
     */
    codeCell: Cell | undefined
    /**
     * Code of an account before transaction
     */
    originalCodeCell: Cell | undefined
    /**
     * Information about in-message
     */
    inMsg: TraceInMessage
    /**
     * Information about money-related things
     */
    money: TraceMoneyResult
    /**
     * Information about emulated transaction
     */
    emulatedTx: TraceEmulatedTx
    emulatorVersion: {
        commitHash: string
        commitDate: string
    }
}

export type StateFromAPI =
    | {
          type: "uninit"
      }
    | {
          data: string | null
          code: string | null
          type: "active"
      }
    | {
          type: "frozen"
          stateHash: string
      }

export interface AccountFromAPI {
    balance: {
        coins: string
        currencies: Record<string, string>
    }
    state: StateFromAPI
    last: {
        lt: string
        hash: string
    } | null
    storageStat: {
        lastPaid: number
        duePayment: string | null
        used: {
            bits: number
            cells: number
            publicCells?: number | undefined
        }
    } | null
}

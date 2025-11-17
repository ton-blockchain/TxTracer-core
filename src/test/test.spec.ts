import {retrace, retraceBaseTx} from "../runner"
import {TraceResult} from "../types"
import {Buffer} from "buffer"
import {Address} from "@ton/core"

const DEFAULT_TIMEOUT = 100_000

describe("transactions", () => {
    it(
        "should return correct information for transaction without libs and exit code 709",
        async () => {
            const txLink = "3c1b02a33390e596d83b306eab57b3f7271bc90e2e527ea4cafccfde25139d41"
            const testnet = false

            const res = await retrace(testnet, txLink)
            checkResult(res)
        },
        DEFAULT_TIMEOUT,
    )

    it(
        "should return correct information for simple transaction with exit code 0",
        async () => {
            const txLink = "9432b11f810c58b38658cbc41c52dd01cf3af18e950d375dcc867077554e4550"
            const testnet = false

            const res = await retrace(testnet, txLink)
            checkResult(res)
        },
        DEFAULT_TIMEOUT,
    )

    it(
        "should return correct information for transaction for code with single exotic library cell",
        async () => {
            const txLink = "4295a2c06ca9b0242d4b6638e4eb1a8da91a9d75dbeae4acc13a4355a4dd7a6a"
            const testnet = false

            const res = await retrace(testnet, txLink)
            checkResult(res)
        },
        DEFAULT_TIMEOUT,
    )

    it(
        "should return correct information for transaction for code with several exotic library cells",
        async () => {
            const txLink = "440e0490bd5efee08b23cf33e2cfd9b8d414c4cb717d3f92727fa49d4c51a09d"
            const testnet = false

            const res = await retrace(testnet, txLink)
            checkResult(res)
        },
        DEFAULT_TIMEOUT,
    )

    it(
        "should return correct information for transaction with external-in message for wallet v5 that txtracer cannot fully recreate",
        async () => {
            const txLink = "d6b814f76ec8cae17664ceba18b978e510f2249b36a35bf7227db121c1516e96"
            const testnet = false

            // wrong totalFee, likely bug in the sandbox
            const res = await retrace(testnet, txLink)
            checkResult(res, false)
        },
        DEFAULT_TIMEOUT,
    )

    it(
        "should return correct information for transaction with external-in message for wallet v4",
        async () => {
            const txLink = "f8b7a5b598c65ecb180338eec103bf28c199bf8346453342eb7022ccf2ea39f6"
            const testnet = false

            const res = await retrace(testnet, txLink)
            checkResult(res)
        },
        DEFAULT_TIMEOUT,
    )

    it(
        "should return correct information for transaction for uninit transaction with StateInit code",
        async () => {
            const txLink = "5abe43cce74d536cdae76b989e55f7b37c61381308b8f1a4b8ecc3098c4b8b39"
            const testnet = false

            const res = await retrace(testnet, txLink)
            checkResult(res)
        },
        DEFAULT_TIMEOUT,
    )

    it(
        "should return correct information for transaction with exotic cell library in in-message",
        async () => {
            const txLink = "f64c6a3cdf3fad1d786aacf9a6130f18f3f76eeb71294f53bbd812ad3703e70a"
            const testnet = false

            const res = await retrace(testnet, txLink)
            checkResult(res)
        },
        DEFAULT_TIMEOUT,
    )

    it(
        "should return correct information for base transaction",
        async () => {
            const testnet = false

            const res = await retraceBaseTx(testnet, {
                lt: 56_166_043_000_001n,
                hash: Buffer.from("T6Y6ZoW71mrznFA0RyU/xV5ILpz9WUPJ9i9/4xPq1Is=", "base64"),
                address: Address.parse("EQCqKZrrce8Ss6SZaLI-OkH2w8-xtPP9_ZvyyIZLhy9Hmpf8"),
            })
            checkResult(res)
        },
        DEFAULT_TIMEOUT,
    )

    it(
        "should return correct information for transaction with library load from mainnet",
        async () => {
            const txLink = "a63b8b2f4b4493de5e67031ba3d65c7a8c0938ab56327608fb42bcbee901e4b7"
            const testnet = false

            const res = await retrace(testnet, txLink)
            checkResult(res)
        },
        DEFAULT_TIMEOUT,
    )

    describe("TVM version support", () => {
        it(
            "TVM version v12",
            async () => {
                const txLink = "fadd5a2d53a26c4e8694e9e992c4f53f981655593b24847f19727c1140a255be"
                const testnet = true

                const res = await retrace(testnet, txLink)
                checkResult(res)
            },
            DEFAULT_TIMEOUT,
        )
    })

    function checkResult(res: TraceResult, expectedOk: boolean = true): void {
        expect(res.stateUpdateHashOk).toEqual(expectedOk)
        expect(res.codeCell?.toBoc().toString("hex")).toMatchSnapshot()
        expect(res.originalCodeCell?.toBoc().toString("hex")).toMatchSnapshot()
        expect(res.inMsg.sender?.toString()).toMatchSnapshot()
        expect("0x" + res.inMsg.opcode?.toString(16)).toMatchSnapshot()
        expect(res.inMsg.contract.toString()).toMatchSnapshot()
        expect(res.inMsg.amount).toMatchSnapshot()
        expect(res.emulatedTx.lt).toMatchSnapshot()
        expect(res.emulatedTx.utime).toMatchSnapshot()
        expect(res.emulatedTx.computeInfo).toMatchSnapshot()
        expect(res.emulatedTx.c5?.toString()).toMatchSnapshot()
        expect(res.emulatedTx.raw).toMatchSnapshot()
        expect(res.money).toMatchSnapshot()
    }
})

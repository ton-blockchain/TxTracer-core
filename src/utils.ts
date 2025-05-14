import {Buffer} from "buffer"

export async function wait(delay: number): Promise<unknown> {
    return new Promise(resolve => setTimeout(resolve, delay))
}

export function base64ToBigint(b64: string): bigint {
    return BigInt("0x" + Buffer.from(b64, "base64").toString("hex"))
}

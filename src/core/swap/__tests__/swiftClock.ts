/**
 * Test helper ( ): the clock a live Mayan Swift fixture is checked at.
 *
 * The signing guards refuse a Swift order whose deadline has passed or is more than an hour
 * away, so a fixture captured on 2026-09-27 is checked at its capture time, not today's. The
 * EVM → EVM captures record `capturedAt`; the older EVM → Solana and Solana-source captures do
 * not, so they are checked CAPTURE_LEAD_SEC before their order's deadline — every capture that
 * records its time carries a deadline 716–901 s after it (28 captures). The deadline is read here
 * from the raw calldata / instruction bytes, independently of the guards' own decoders.
 */
import { ethers } from 'ethers';
import { Buffer } from 'buffer';
import { VersionedTransaction } from '@solana/web3.js';

/** How long before its order's deadline a fixture without a recorded capture time is checked. */
export const CAPTURE_LEAD_SEC = 600;

const FACET = new ethers.Interface([
    'function swapAndStartBridgeTokensViaMayan((bytes32,string,string,address,address,address,uint256,uint256,bool,bool) bridgeData, (address,address,address,address,uint256,bytes,bool)[] swapData, (bytes32 nonEVMReceiver, address mayanProtocol, bytes protocolData, address swapProtocol, bytes swapData, address middleToken, uint256 minMiddleAmount, address refundRecipient, uint256 mayanAmountIn) mayanData)',
]);
const SWIFT = new ethers.Interface([
    'function createOrderWithToken(address tokenIn, uint256 amountIn, (uint8 payloadType, bytes32 trader, bytes32 destAddr, uint16 destChainId, bytes32 referrerAddr, bytes32 tokenOut, uint64 minAmountOut, uint64 gasDrop, uint64 cancelFee, uint64 refundFee, uint64 deadline, uint8 referrerBps, uint8 auctionMode, bytes32 random) params, bytes customPayload)',
]);

/** The Swift order deadline inside a LI.FI MayanFacet call (EVM source). */
export function evmSwiftDeadline(diamondCalldata: string): bigint {
    const t = FACET.parseTransaction({ data: diamondCalldata });
    if (!t) throw new Error('not a swapAndStartBridgeTokensViaMayan call');
    const md = t.args.mayanData as unknown as { protocolData: string };
    const order = SWIFT.decodeFunctionData('createOrderWithToken', md.protocolData);
    return (order[2] as unknown as { deadline: bigint }).deadline;
}

/** Swift v2 `init_order` (Anchor discriminator 204c290c27a284db, 198 bytes): deadline u64 LE at byte 123. */
export function solanaSwiftDeadline(txBase64: string): bigint | null {
    const vtx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(txBase64, 'base64')));
    for (const ix of vtx.message.compiledInstructions) {
        const d = Buffer.from(ix.data);
        if (d.length === 198 && d.subarray(0, 8).toString('hex') === '204c290c27a284db') return d.readBigUInt64LE(123);
    }
    return null;
}

/** Unix seconds to check a fixture order at: its deadline less CAPTURE_LEAD_SEC. */
export const nowBefore = (deadline: bigint): number => Number(deadline) - CAPTURE_LEAD_SEC;

/** Unix seconds of a recorded capture time. */
export const captureSec = (capturedAt: string): number => Math.floor(Date.parse(capturedAt) / 1000);

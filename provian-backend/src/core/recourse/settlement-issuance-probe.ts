import { Interface } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { currentProtocolDeployment } from '../protocol/runtime';
import { MEMBER_SETTLEMENT_ABI } from './issuance-ticket';

const fail = (reason: string): never => { throw Error(`recourse_issuance_probe_${reason}`); };
// Only work-specific kernel refusals can inform bisection. Epoch/cursor lag,
// verifier visibility, pool consent and configuration failures say nothing
// about a claim and must not quarantine it.
const claimErrors = new Interface([
  'error InvalidClaim()', 'error ClaimAlreadySettled()', 'error InvalidGenesisGrant()',
  'error GenesisAnchorAlreadyUsed()', 'error GenesisWalletCeilingExceeded()',
  'error GenesisQualificationOutsideWindow()', 'error BeneficiaryClassificationInvalid()',
  'error ArithmeticDomainExceeded()',
]);
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Read structured revert bytes, never an error message containing hex. */
function revertBytes(error: unknown): string {
  const row = object(error);
  const rpc = object(object(row?.info)?.error) ?? object(row?.error);
  const value = row?.code === 'CALL_EXCEPTION' ? row.data : rpc?.code === 3 ? rpc.data : null;
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(value)) return fail('inconclusive');
  return value.toLowerCase();
}

/** Decode exactly one outer rollback result. A nested forged success marker
 * stays a failed inner execution; it is never recursively interpreted. */
export function decodeIssuanceProbe(value: string): { ok: boolean; revertReason: string | null } {
  let decoded;
  try { decoded = MEMBER_SETTLEMENT_ABI.decodeErrorResult('ProbeResult', value); }
  catch { return fail('inconclusive'); }
  const success: unknown = decoded[0], result: unknown = decoded[1];
  if (typeof success !== 'boolean' || typeof result !== 'string'
    || MEMBER_SETTLEMENT_ABI.encodeErrorResult('ProbeResult', [success, result]) !== value.toLowerCase()
    || (success ? result !== '0x' : result === '0x')) return fail('inconclusive');
  if (!success) {
    let reason;
    try { reason = claimErrors.parseError(result); } catch { return fail('inconclusive'); }
    if (!reason || claimErrors.encodeErrorResult(reason.fragment, reason.args) !== result) return fail('inconclusive');
  }
  return { ok: success, revertReason: success ? null : result };
}

/** Two independent operators must return the same canonical rollback result at
 * the same block. OOG, timeout, missing bytes or disagreement cannot blame work. */
export async function simulatePrivateIssuanceProbe(input: {
  readonly target: string; readonly data: string; readonly blockHash: string; readonly manifestHash: string;
}, gasPayer: string): Promise<{ ok: boolean; revertReason: string | null }> {
  const parsed = MEMBER_SETTLEMENT_ABI.parseTransaction({ data: input.data });
  const deployment = await currentProtocolDeployment();
  if (!parsed || parsed.name !== 'probeMemberBatch' || deployment.manifestHash !== input.manifestHash
    || deployment.addresses.settlement.toLowerCase() !== input.target) return fail('domain');
  const legs = getOperatorBoundRpcLegs('base');
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) return fail('operators');
  const headers = await Promise.all(legs.map(leg => leg.provider.send('eth_getBlockByHash', [input.blockHash, false])));
  const firstHeader = object(headers[0]), secondHeader = object(headers[1]);
  const height = firstHeader?.number;
  if (firstHeader?.hash !== input.blockHash || secondHeader?.hash !== input.blockHash || secondHeader?.number !== height
    || typeof height !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(height)) return fail('inconclusive');
  const replies = await Promise.allSettled(legs.map(leg => leg.provider.send('eth_call', [
    { to: input.target, from: gasPayer, data: input.data }, { blockHash: input.blockHash, requireCanonical: true },
  ])));
  if (replies[0].status !== 'rejected' || replies[1].status !== 'rejected') return fail('did_not_revert');
  const first = revertBytes(replies[0].reason), second = revertBytes(replies[1].reason);
  if (first !== second) return fail('disagreement');
  const canonical = await Promise.all(legs.map(leg => leg.provider.send('eth_getBlockByNumber', [height, false])));
  if (canonical.some(header => object(header)?.hash !== input.blockHash || object(header)?.number !== height)) return fail('reorg');
  if ((await currentProtocolDeployment({ fresh: true })).manifestHash !== input.manifestHash) return fail('domain');
  return decodeIssuanceProbe(first);
}

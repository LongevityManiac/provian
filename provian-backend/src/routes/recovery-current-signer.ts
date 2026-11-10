import { TypedDataEncoder } from 'ethers';
import { getOperatorBoundRpcLegs } from '../core/onchain/rpc-provider';
import { verifyHashDestinationDigest } from '../core/recourse/hash-destination-proof';
import { RECOVERY_DOMAIN, RECOVERY_TYPES, recoverRecoverySigner, type RecoveryMessage } from './recovery-eip712';

interface Ports {
  code(address: string): Promise<string>;
  verifyHash: typeof verifyHashDestinationDigest;
}
async function code(address: string): Promise<string> {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recovery_rpc_operators_not_independent');
  const blocks = await Promise.all(legs.map(leg => leg.provider.send('eth_getBlockByNumber', ['finalized',false])));
  if (!blocks[0] || typeof blocks[0].hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(blocks[0].hash)
    || blocks[0].hash !== blocks[1]?.hash) throw Error('recovery_rpc_disagreement');
  const values = await Promise.all(legs.map(leg => leg.provider.send('eth_getCode', [address,{blockHash:blocks[0].hash,requireCanonical:true}])));
  if (typeof values[0] !== 'string' || values[0] !== values[1] || !/^0x(?:[0-9a-f]{2})*$/.test(values[0])) throw Error('recovery_rpc_disagreement');
  return values[0];
}
/** Signature choice comes from independently read account code. A caller cannot
 * substitute a curve proof for a recovered hash account. EIP-7702 delegation
 * preserves an EOA's curve ownership; arbitrary contracts do not qualify. */
export async function recoverCurrentRecoverySigner(message: RecoveryMessage, signature: string,
  ports: Ports = { code, verifyHash:verifyHashDestinationDigest }): Promise<string> {
  const address = message.user.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address) || typeof signature !== 'string') throw Error('recovery_signature_invalid');
  const runtime = await ports.code(address);
  if (runtime === '0x' || /^0xef0100[0-9a-f]{40}$/.test(runtime)) {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw Error('recovery_signature_invalid');
    return recoverRecoverySigner(message, signature);
  }
  await ports.verifyHash(address, TypedDataEncoder.hash(RECOVERY_DOMAIN, RECOVERY_TYPES, message), signature);
  return address;
}

import { confirmProtocolDeployment, resolveHistoricalProtocolDeployment, type PointerRpc } from './protocol-pointer';
import { packProtocolProof, unpackProtocolProof } from './protocol-verification';

/** Build-time only: fully verify a finalized deployment, then prove it is current. */
export async function buildProtocolProof(rpcs: readonly [PointerRpc, PointerRpc], pointer: string,
  runtimeHash: string, operators: readonly [string, string], previous?: string): Promise<string> {
  const heads = await Promise.all(rpcs.map(async rpc => {
    const value = await rpc.request('eth_getBlockByNumber', ['finalized', false]);
    if (!value || typeof value !== 'object' || !('number' in value) || !('hash' in value)
      || typeof value.number !== 'string' || !/^0x[0-9a-f]+$/i.test(value.number)
      || typeof value.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.hash)) throw Error('protocol_build_finalized_invalid');
    const height = Number(BigInt(value.number));
    if (!Number.isSafeInteger(height) || height < 0) throw Error('protocol_build_finalized_invalid');
    return { height, hash: value.hash.toLowerCase() };
  }));
  const anchor = heads[0].height <= heads[1].height ? heads[0] : heads[1];
  if (heads[0].height === heads[1].height && heads[0].hash !== heads[1].hash) throw Error('protocol_build_finalized_disagreement');
  const proof = await resolveHistoricalProtocolDeployment(rpcs, pointer, runtimeHash, anchor.height, anchor.hash);
  if (!await confirmProtocolDeployment(rpcs, proof, runtimeHash)) throw Error('protocol_build_revision_changed');
  const options = { pointer, runtimeHash, operators, rpcs, store: { load: async () => null, save: async () => {} } };
  // Keep reproducible release bytes when the fully verified revision is unchanged.
  // Its original anchor must still pass fresh confirmation; otherwise regenerate.
  if (previous) {
    try {
      const old = unpackProtocolProof(previous, options);
      if (old.revision > proof.revision) throw Error('protocol_build_rollback');
      if (old.revision === proof.revision && old.manifestHash === proof.manifestHash
        && await confirmProtocolDeployment(rpcs, old, runtimeHash)) return previous;
    } catch (error) {
      if (error instanceof Error && error.message === 'protocol_build_rollback') throw error;
    }
  }
  // A prior anchor may have failed or the pointer may have advanced during its
  // check. The newly generated proof must still pass at the final build boundary.
  if (!await confirmProtocolDeployment(rpcs, proof, runtimeHash)) throw Error('protocol_build_revision_changed');
  return packProtocolProof(proof, options);
}

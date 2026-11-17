/**
 * A Replication Pack raises a device act to `software_verified` only when it is whole: input,
 * output and pack hashes all present, each a SHA-256 digest. Anything less is no pack — the act
 * keeps the lane's own tier and records no pack.
 */
import { describe, it, expect } from '@jest/globals';
import { deviceActToAccrualParams, type DeviceBatchLane } from './device-act';
import type { ActRecord } from './meter-wire';
import type { DeviceDocument } from '../../routes/middleware/device-auth';

const H = (c: string) => `sha256:${c.repeat(64)}`;
const lane = (): DeviceBatchLane => ({
  device: { owner_type: 'agent', device_id: 'fixture' } as DeviceDocument,
  bodyBound: true, signatureAuthenticated: true, attestationTier: 'software', ownerId: 'fixture',
  receivedAtMs: Date.now(), lineage: null, lineageTouched: false,
} as DeviceBatchLane);
const act = (replication_pack: unknown): ActRecord => ({
  action_type: 'compute_session', pe_id: 'fixture', timestamp: Date.now(), device_id: 'fixture', prev_hash: 'genesis',
  pricing: { metadata: {}, replication_pack }, pe_hash: H('a'),
} as unknown as ActRecord);

async function mapped(replication_pack: unknown): Promise<{ tier: unknown; pack: unknown }> {
  const result = await deviceActToAccrualParams(lane(), act(replication_pack), 'fixture');
  if (!result.ok) throw new Error(`act refused: ${result.reason}`);
  return { tier: result.params.attestationDepth, pack: result.params.replication_pack };
}

describe('replication pack tier upgrade', () => {
  const whole = { input_hash: H('1'), output_hash: `0x${'2'.repeat(64)}`, pack_hash: '3'.repeat(64), model_id: 'provider/model/1' };

  it('control: a whole pack is recorded and raises the act to software_verified', async () => {
    expect(await mapped(whole)).toEqual({
      tier: 'software_verified',
      pack: { input_hash: whole.input_hash, output_hash: whole.output_hash, pack_hash: whole.pack_hash, model_id: whole.model_id, model_checkpoint_hash: null },
    });
  });

  const incomplete: readonly [string, Record<string, unknown>][] = [
    ['no pack_hash', { input_hash: whole.input_hash, output_hash: whole.output_hash }],
    ['a null pack_hash', { ...whole, pack_hash: null }],
    ['an empty pack_hash', { ...whole, pack_hash: '' }],
    ['a pack_hash that is not a digest', { ...whole, pack_hash: 'yes' }],
    ['a non-string pack_hash', { ...whole, pack_hash: 7 }],
    ['an input_hash that is not a digest', { ...whole, input_hash: 'x' }],
    ['an output_hash that is not a digest', { ...whole, output_hash: 'y' }],
    ['a short digest', { ...whole, output_hash: `sha256:${'2'.repeat(63)}` }],
  ];
  it('the violating population is not empty', () => { expect(incomplete.length).toBeGreaterThan(0); });
  for (const [name, pack] of incomplete) {
    it(`RED: ${name} earns no upgrade and records no pack`, async () => {
      expect(await mapped(pack)).toEqual({ tier: 'software', pack: undefined });
    });
  }
});
